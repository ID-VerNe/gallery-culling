/**
 * 导出名三处一致（issue #124）。
 *
 * ## 防的是什么
 *
 * `EXPORT_MANIFEST_NAME` / `EXPORT_TMP_PREFIX` 在 Rust / 前端 / e2e 三处手写，
 * 此前零校验（`AGENTS.md` 只自述前后端两处，未提 e2e 与 tmp 前缀）：
 *
 * - 改 Rust 清单名而前端 / e2e 未同步 → 结果条给出错误文件名（`ExportResultPanel`）
 * - 改 Rust tmp 前缀而 e2e 未同步 → 残留检查比对的不是真的临时目录，假绿
 * - 改 e2e 任一字面量 → 同上，但 e2e 不进 CI 的 manual 档，`npm run gates` 照样全绿
 *
 * 这类「改一处、他处静默错」只有机器比对能钉住。Rust 两常量是写盘真值，前端与
 * e2e 都是它的副本；门禁把副本逐个对到真值上。
 *
 * ## 为什么按 `.gallery-export*` 子串提取，而不是整串字面相等
 *
 * e2e 里除了 `'...includes(\'.gallery-export.json\')'` 这类整串引用，还有描述句
 * `'写入 .gallery-export.json'`（`e2e/run-inapp.mjs:111`）与
 * `'写入 .gallery-export.json manifest'`（`e2e/suites/05-export.mjs:57`）。
 * 按整串相等会把描述句误判成漂移。这里只抓以 `.gallery-export` 开头的
 * 子串：描述句里那个子串恰是清单名（绿），漂移值（如 `.gallery-export-DRIFT.json`）
 * 既不等于清单名也不等于 tmp 前缀（红），两种情形都被正确区分。
 *
 * ## 为什么不做单源
 *
 * 本门禁刻意只**比对**，不建 JSON 单源、不走运行时 IPC、不改 Rust 常量值，
 * 也不让 e2e 直接 import TS（无 tsx loader）。单源与 IPC 都是远期重构，另开 issue；
 * 这里先把漂移变成红灯。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const RUST_REL = join('src-tauri', 'src', 'commands', 'export.rs');
const TS_REL = join('src', 'components', 'export', 'exportMessages.ts');
const E2E_DIRNAME = 'e2e';

/** 以 `.gallery-export` 开头的子串（到空白或引号 / 括号为止）。 */
const EXPORT_SUBSTRING_RE = /\.gallery-export[^\s'"`)\]}]*/g;

/**
 * 从 Rust 源码解析两常量。返回 `{ manifest, tmpPrefix, problems }`。
 * 纯函数：`problems` 非空时另两项无意义，判定层直接判红，不拿半份数据比对。
 */
export function parseRustConstants(source) {
  const manifestMatch = source.match(
    /pub\s+const\s+EXPORT_MANIFEST_NAME\b[^=]*=\s*"([^"]+)"/,
  );
  const tmpMatch = source.match(
    /pub\s+const\s+EXPORT_TMP_PREFIX\b[^=]*=\s*"([^"]+)"/,
  );
  const problems = [];
  if (!manifestMatch) {
    problems.push('Rust 里解析不到 `pub const EXPORT_MANIFEST_NAME`（`commands/export.rs`）');
  }
  if (!tmpMatch) {
    problems.push('Rust 里解析不到 `pub const EXPORT_TMP_PREFIX`（`commands/export.rs`）');
  }
  return {
    manifest: manifestMatch?.[1] ?? null,
    tmpPrefix: tmpMatch?.[1] ?? null,
    problems,
  };
}

/**
 * 从 `exportMessages.ts` 解析清单独个常量。返回 `{ value, problems }`。
 */
export function parseTsManifest(source) {
  const matched = source.match(
    /export\s+const\s+EXPORT_MANIFEST_NAME\s*=\s*(?:'([^']+)'|"([^"]+)")/,
  );
  if (!matched) {
    return {
      value: null,
      problems: ['TS 里解析不到 `export const EXPORT_MANIFEST_NAME`（`exportMessages.ts`）'],
    };
  }
  return { value: matched[1] ?? matched[2] ?? null, problems: [] };
}

/**
 * 从一段 e2e 源码里抽出所有 `.gallery-export*` 子串（去重保留原序）。
 */
export function extractE2eNames(source) {
  const found = new Set();
  for (const match of source.matchAll(EXPORT_SUBSTRING_RE)) {
    found.add(match[0]);
  }
  return [...found];
}

/**
 * 递归收集 `e2e/` 下的 `.mjs` 文件（动态扫描：新增 suite 自动覆盖）。
 */
export function collectE2eFiles(root = ROOT) {
  const dir = join(root, E2E_DIRNAME);
  const acc = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(full);
      else if (/\.mjs$/.test(entry)) acc.push(full);
    }
  };
  walk(dir);
  return acc.sort();
}

/**
 * 一致性判定：返回 `{ ok, message }`。纯函数，便于单测与变异。
 *
 * `e2e` 形如 `[{ file, names }]`，`file` 是相对路径（仅用于报错）。
 */
export function judgeExportNames({ rust, ts, e2e }) {
  const problems = [];
  problems.push(...rust.problems);
  problems.push(...ts.problems);

  if (rust.manifest && ts.value && ts.value !== rust.manifest) {
    problems.push(
      `TS 的 EXPORT_MANIFEST_NAME 是 \`${ts.value}\`，与 Rust 的 \`${rust.manifest}\` 不一致` +
        '（`exportMessages.ts`）',
    );
  }

  const occurrences = [];
  for (const entry of e2e) {
    for (const name of entry.names) occurrences.push({ file: entry.file, name });
  }
  if (rust.manifest && rust.tmpPrefix) {
    for (const { file, name } of occurrences) {
      if (name !== rust.manifest && name !== rust.tmpPrefix) {
        problems.push(
          `${file} 里的 \`${name}\` 与 Rust 的清单名 \`${rust.manifest}\`、tmp 前缀 ` +
            `\`${rust.tmpPrefix}\` 均不相等`,
        );
      }
    }
    const seen = new Set(occurrences.map((item) => item.name));
    if (!seen.has(rust.manifest)) {
      problems.push(`e2e 里没有出现清单名 \`${rust.manifest}\`（检查被删了？）`);
    }
    if (!seen.has(rust.tmpPrefix)) {
      problems.push(`e2e 里没有出现 tmp 前缀 \`${rust.tmpPrefix}\`（残留检查被删了？）`);
    }
  }

  if (problems.length === 0) {
    const e2eCount = occurrences.length;
    const distinct = new Set(occurrences.map((item) => item.name)).size;
    return {
      ok: true,
      message:
        `PASS: 导出名三处一致（清单 ${rust.manifest} / tmp ${rust.tmpPrefix}；` +
        `TS 1 处、e2e ${e2eCount} 处/${distinct} 种，issue #124）。`,
    };
  }

  return {
    ok: false,
    message:
      `FAIL: 导出名三处不一致（${problems.length} 处）：\n` +
      problems.map((problem) => `  - ${problem}`).join('\n') +
      '\n  处置：以 Rust `commands/export.rs` 的两常量为准，把 TS `exportMessages.ts` 与 ' +
      'e2e 字面量都对齐到同一个值，别只改一边。e2e 描述句里的 `.gallery-export*` 子串同样算引用。',
  };
}

/** 读盘这一层：解析三处并判定，返回 `{ ok, message }`。 */
export function checkExportNames({
  root = ROOT,
  read = (path) => readFileSync(path, 'utf8'),
} = {}) {
  const rustPath = join(root, RUST_REL);
  const tsPath = join(root, TS_REL);
  let rustSource;
  let tsSource;
  try {
    rustSource = read(rustPath);
  } catch {
    return { ok: false, message: `FAIL: 读不到 ${relative(root, rustPath)}` };
  }
  try {
    tsSource = read(tsPath);
  } catch {
    return { ok: false, message: `FAIL: 读不到 ${relative(root, TS_REL)}` };
  }
  const rust = parseRustConstants(rustSource);
  const ts = parseTsManifest(tsSource);
  const e2e = [];
  for (const file of collectE2eFiles(root)) {
    let source;
    try {
      source = read(file);
    } catch {
      continue;
    }
    const names = extractE2eNames(source);
    if (names.length > 0) e2e.push({ file: relative(root, file), names });
  }
  return judgeExportNames({ rust, ts, e2e });
}

function main() {
  const { ok, message } = checkExportNames();
  (ok ? console.log : console.error)(message);
  return ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
