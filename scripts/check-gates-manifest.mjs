/**
 * 元门禁：门禁清单、磁盘脚本、AGENTS.md 生成段、CI 分片矩阵，四者零漂移（issue #6）。
 *
 * 它防的是**门禁自己悄悄失效**：新增一条 `scripts/check-*.mjs` 却不登记进
 * `gates.json`，或登记了却删了脚本，或 `ci.yml` 的 matrix 与清单分片对不上 ——
 * 这些都不会让任何一条业务门禁变红，只会让「跑过门禁」变成一句空话。
 *
 *     node scripts/check-gates-manifest.mjs           # 校验
 *     node scripts/check-gates-manifest.mjs --write   # 重写 AGENTS.md 的生成段
 *
 * 校验项：
 *  1. 磁盘上每个 `scripts/check-*.mjs` 恰好登记在一个档位里；
 *  2. 清单里每个 `check-*.mjs` 在磁盘上真实存在；
 *  3. 同一条门禁不能同时出现在两个档位；
 *  4. `AGENTS.md` 的 `<!-- gates:ci:begin -->` 段与清单渲染结果逐字一致；
 *  5. `ci.yml` 的 `matrix.shard` 与清单的 `shards` 完全一致（顺序也要一致：
 *     GitHub 上分片是并行跑，但顺序漂移说明有人在两边分别手改过）；
 *  6. 每个 `scripts/*.mjs` 的外部 import（`postcss`、`tailwindcss` 这类）都被某条
 *     **ci 门禁**加载 —— 见 `depProblems` 的注释（issue #24）。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_PATH = join(ROOT, 'scripts', 'gates.json');
export const AGENTS_PATH = join(ROOT, 'AGENTS.md');
export const CI_PATH = join(ROOT, '.github', 'workflows', 'ci.yml');

const BEGIN = '<!-- gates:ci:begin -->';
const END = '<!-- gates:ci:end -->';
const BUCKETS = ['ci', 'manual', 'support'];
/** 只有这种形态的名字才对应磁盘文件；`tsc --noEmit` 这类是直接命令。 */
const SCRIPT_NAME = /^check-[a-z0-9-]+\.mjs$/;

/** 从 `ci.yml` 里取 `shard: [static, unit, rust]`。取不到返回 `null`（区别于「空数组」）。 */
export function parseShardMatrix(yml) {
  const matched = yml.match(/shard:\s*\[([^\]]*)\]/);
  if (!matched) return null;
  return matched[1]
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter((item) => item.length > 0);
}

/** 取 AGENTS.md 里的生成段（含标记行）。没有标记返回 `null`。 */
export function extractAgentsSection(text) {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + END.length);
}

/**
 * 换行符归一。
 *
 * 本仓 `core.autocrlf=true`：检出时 LF 会被换成 CRLF，而 `renderAgentsSection`
 * 吐的是 LF。不做归一的话，**本机绿、新克隆红**（或反过来）——那是最难查的一类
 * 假红。比较与写盘都以文件自身的换行为准。
 */
export function normalizeEol(text) {
  return text.replace(/\r\n/g, '\n');
}

/** 由清单渲染生成段。`--write` 与校验共用，保证「写出来的」就是「校验的」。 */
export function renderAgentsSection(manifest) {
  const rows = (manifest.ci ?? []).map((row, index) =>
    `| ${index + 1} | \`${row.shard}\` | \`${row.name}\` | ${row.why} |`,
  );
  const tally = (manifest.shards ?? [])
    .map((shard) => {
      const count = (manifest.ci ?? []).filter((row) => row.shard === shard.name).length;
      return `${shard.name} ${count}`;
    })
    .join('、');
  const manual = (manifest.manual ?? []).length;
  const support = (manifest.support ?? []).length;

  return [
    BEGIN,
    '> 本节由 `node scripts/check-gates-manifest.mjs --write` 从 `scripts/gates.json` 生成，**不要手改**；顺序即本机全量执行顺序，`分片` 列即 CI matrix 分片（同片串行、片间并行）。',
    '',
    '| # | 分片 | 门禁 | 防什么 |',
    '|---|---|---|---|',
    ...rows,
    '',
    `共 ${(manifest.ci ?? []).length} 个 CI 门禁，分 ${(manifest.shards ?? []).length} 个分片（${tally}）；manual ${manual}、support ${support} 见 \`scripts/gates.json\`。`,
    END,
  ].join('\n');
}

/**
 * 纯函数校验：四份输入进，问题列表出（空数组 = 通过）。
 *
 * 刻意把 IO 全留在 `main` 里，这样每条规则都能在单测里造数据打红。
 */
export function diffManifest({ diskCheckScripts, manifest, agentsSection, ciShards }) {
  const problems = [];

  const registered = [];
  for (const bucket of BUCKETS) {
    for (const row of manifest[bucket] ?? []) {
      if (SCRIPT_NAME.test(row.name)) registered.push({ bucket, name: row.name });
    }
  }

  const onDisk = new Set(diskCheckScripts);
  for (const script of onDisk) {
    const hits = registered.filter((row) => row.name === script);
    if (hits.length === 0) {
      problems.push(`磁盘上有 ${script}，但 gates.json 三个档位都没登记（新增门禁必须进清单）`);
    } else if (hits.length > 1) {
      problems.push(
        `${script} 同时登记在多个档位：${hits.map((hit) => hit.bucket).join('、')}（每个门禁只归一个档位）`,
      );
    }
  }
  for (const row of registered) {
    if (!onDisk.has(row.name)) {
      problems.push(`gates.json 的 ${row.bucket} 档登记了 ${row.name}，但磁盘上没有这个脚本`);
    }
  }

  if (agentsSection === null) {
    problems.push('AGENTS.md 里找不到生成段标记（<!-- gates:ci:begin --> / <!-- gates:ci:end -->）');
  } else {
    const expected = renderAgentsSection(manifest);
    if (normalizeEol(agentsSection).trim() !== normalizeEol(expected).trim()) {
      problems.push('AGENTS.md 的生成段与 gates.json 不一致（跑 --write 重写，不要手改）');
    }
  }

  if (ciShards === null) {
    problems.push('.github/workflows/ci.yml 里找不到 `shard: [...]`（分片矩阵是 CI 的入口）');
  } else {
    const declared = (manifest.shards ?? []).map((shard) => shard.name);
    if (declared.join(',') !== ciShards.join(',')) {
      problems.push(
        `ci.yml 的分片 [${ciShards.join(', ')}] 与 gates.json 的 [${declared.join(', ')}] 不一致`,
      );
    }
  }

  return problems;
}

/**
 * import / require 的说明符 -> 包名。跳过 `node:` 内置与相对路径。
 *
 * 一段源码里能加载一个包的写法只有这几种：`import x from 'p'`、`export … from 'p'`、
 * 副作用 `import 'p'`、动态 `await import('p')`、`require('p')`。
 *
 * **只认字面量说明符**。拼接出来的（`import('post' + 'css')`）和模板里的
 * （`` import(`${x}`) ``）一律看不见——本函数是正则而不是解析器，静态判不出结果。
 * 所以 `depProblems` 承诺的是「字面量说明符的外部依赖被人加载」，不是「所有外部依赖」；
 * 把本文件改成正则再加分支救不了这一类，要救得换成真正的 AST 扫描。
 */
const SPECIFIER_PATTERNS = [
  /\bfrom\s+['"]([^'"]+)['"]/g, // import … from 'p' / export … from 'p'
  /(?<![\w$.])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // await import('p')
  /(?<![\w$.])import\s+['"]([^'"]+)['"]/g, // import 'p'（副作用）
  /(?<![\w$.])require\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require('p')
];

export function externalImports(source) {
  const names = new Set();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const matched of source.matchAll(pattern)) {
      const specifier = matched[1];
      if (specifier.startsWith('node:') || specifier.startsWith('.')) continue;
      names.add(
        specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0],
      );
    }
  }
  return [...names].sort();
}

/**
 * 每个 `scripts/check-*.mjs` 的外部 import 都必须被某条 **ci 门禁**加载。
 *
 * ## 防的是什么
 *
 * `check-theme-alpha.mjs` / `check-borders-emitted.mjs` 在内存里跑 Tailwind，要 import
 * `postcss` 与 `tailwindcss`。缺了它们，脚本以 `ERR_MODULE_NOT_FOUND` 崩掉，门禁红 ——
 * 这正是我们想要的 fail-closed。在本地有 node_modules 时看不出任何问题。
 *
 * 问题是 `check-pr-parity.mjs` 的干净检出可能落在「`node_modules` 在、内容空」的状态：
 * `linkModules` 与 runner 的 `missingTools` 都只看**入口文件**在不在，看不见包内容。
 * 两者都可能绿，真正缺的是包内容。此时若清单里恰好没有会 import 这两个包的脚本，
 * parity 会报 PASS —— 它验的是一个产品里根本不存在的东西（issue #24 排查记录）。
 * 注意 2026-11-02 起 `linkModules` 已改成按同一批入口文件探（见 `probeContents`），
 * 所以「环境坏到只剩空目录」现在会在 parity 入口判退出 2；本约束防的是另一半：
 * 环境**看起来**配齐了，而清单让某个包压根不在任何一条 ci 门禁的加载路径上。
 *
 * 这条约束不预先知道缺哪个包，也不再追求「缺依赖时一定有门禁先撞上」那种强承诺 ——
 * 它保证的是：**凡是被加载的 `check-*.mjs` 用到的外部包，都在某个 `ci` 门禁的加载路径上**。
 * 范围限定在 `externalImports` 认得的那几种写法（字面量说明符），原因见该函数注释。
 * 它管不到的是 `ci` 门禁本身在缺依赖时怎么失败：`node scripts/x.mjs` 撞
 * `ERR_MODULE_NOT_FOUND`（退出 1，门禁红，是对的），但经 `vitest` 加载的用例会在
 * 模块图里缺包时红成什么样，取决于 vitest 自己的加载顺序，不在本约束的推理范围里。
 *
 * 只查 `check-*.mjs`：`release.mjs` 这类工具脚本不在清单的管辖范围里（它们不进
 * 任何一个档位，也没有「跑门禁时会加载它」的承诺）。`*.test.mjs` 由 unit 分片的
 * `vitest` 一行加载，名字对不上清单里的 `check-*.mjs` 形态，故按后缀排除。
 */
export function depProblems(scripts, manifest) {
  const sources = new Map(scripts.map((script) => [script.name, script.source]));
  const ciScripts = (manifest.ci ?? []).filter((row) => SCRIPT_NAME.test(row.name));
  // 只认「由 ci 门禁自己 import」这一种加载路径：一个包只要被任何一条 ci 门禁 import 过，
  // 就落在缺依赖必然出事的路径上。`vitest` 经 `*.test.mjs` 间接加载的那一层本函数看不见，
  // 所以不把任何东西算作「被 test 加载」，覆盖面宁窄不虚宽。
  const loaded = new Set(
    ciScripts.flatMap((row) => externalImports(sources.get(row.name) ?? '')),
  );
  const problems = [];
  for (const script of scripts) {
    if (!SCRIPT_NAME.test(script.name)) continue;
    if (ciScripts.some((row) => row.name === script.name)) continue; // 自己就是 ci 门禁
    for (const name of externalImports(script.source)) {
      if (loaded.has(name)) continue;
      problems.push(
        `scripts/${script.name} import 了 \`${name}\`，但清单里没有 ci 门禁会加载它` +
          '（缺依赖时没人撞上 MODULE_NOT_FOUND，parity 会静默通过）',
      );
    }
  }
  return problems;
}

function diskCheckScripts() {
  return readdirSync(join(ROOT, 'scripts')).filter((name) => SCRIPT_NAME.test(name));
}

function main(argv) {
  const args = argv.slice(2);
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const agents = readFileSync(AGENTS_PATH, 'utf8');

  if (args.includes('--write')) {
    // 写回时跟随文件自身的换行（core.autocrlf=true 的检出是 CRLF），
    // 别把一个 CRLF 文件里塞进一段 LF。
    const eol = agents.includes('\r\n') ? '\r\n' : '\n';
    const section = renderAgentsSection(manifest).replace(/\n/g, eol);
    const current = extractAgentsSection(agents);
    if (current === null) {
      console.error('FAIL: AGENTS.md 缺少生成段标记，无法重写');
      return 1;
    }
    writeFileSync(AGENTS_PATH, agents.replace(current, section), 'utf8');
    console.log('已重写 AGENTS.md 的门禁生成段');
    return 0;
  }

  const problems = diffManifest({
    diskCheckScripts: diskCheckScripts(),
    manifest,
    agentsSection: extractAgentsSection(agents),
    ciShards: parseShardMatrix(readFileSync(CI_PATH, 'utf8')),
  });
  for (const name of readdirSync(join(ROOT, 'scripts')).filter((n) => SCRIPT_NAME.test(n))) {
    problems.push(
      ...depProblems(
        [{ name, source: readFileSync(join(ROOT, 'scripts', name), 'utf8') }],
        manifest,
      ),
    );
  }

  if (problems.length > 0) {
    console.error(`FAIL: 门禁清单漂移 ${problems.length} 处`);
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log(
    `PASS: 清单一致（${(manifest.ci ?? []).length} 条 ci、${(manifest.manual ?? []).length} 条 manual、` +
      `${(manifest.support ?? []).length} 条 support；分片 ${(manifest.shards ?? []).map((s) => s.name).join('、')}）`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv));
}
