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
 *     GitHub 上分片是并行跑，但顺序漂移说明有人在两边分别手改过）。
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
