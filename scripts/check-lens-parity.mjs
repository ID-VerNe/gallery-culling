/**
 * 出厂镜头预设前后端一致（issue #125）。
 *
 * ## 防的是什么
 *
 * `BUILTIN_LENS_PRESETS` 在前端 `lensPresets.ts` 与后端的
 * `builtin_lens_presets()` 各存一份且注释自承「同源同序」（issue #145 拆分后
 * 该函数落在 `models/settings.rs`，façade `models.rs` 只做 re-export）：
 *
 * - 改后端默认值而前端未同步 → 前端读失败兜底（`useLensPresets.ts:40`）与
 *   「恢复默认」（`useLensPresets.ts:92`）会把旧列表写回 DB 覆盖新默认
 * - 改任一侧的顺序/其余 5 条 → 此前前端测试仅锁长 + 首条，vitest 照绿，
 *   漂移躺到用户换机才暴露
 *
 * 这类「改一处、他处静默错」只有机器比对能钉住。门禁把两处渲染成
 * 有序三元组（name/focal/aperture）逐条比对；任一字段、顺序或条数漂移都红。
 *
 * ## 为什么不做单源
 *
 * 本门禁刻意只**比对**，不建 JSON 单源、不走运行时 IPC、不改两处常量值与顺序。
 * 单源（Vite 注入 + `include_str!`）是 issue 列出的中期，另开 issue；这里先把
 * 漂移变成红灯。渲染失败（解析不到定义、条目为零）同样判红——门禁的价值就在于
 * 「定义被删了」也被看见，不拿半份数据判绿。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TS_REL = join('src', 'utils', 'lensPresets.ts');
// issue #145 把 models.rs 按域拆分后，builtin_lens_presets() 落在 models/settings.rs。
// 这里扫 façade + models/ 域文件，定义在且仅在一个文件里才解析，避免再硬编码路径。
const RUST_REL = join('src-tauri', 'src', 'models.rs');
const RUST_DOMAIN_DIR = join('src-tauri', 'src', 'models');
const RUST_LABEL = 'models.rs / models/*.rs';

const TS_ENTRY_RE =
  /\{\s*name:\s*(?:'([^']*)'|"([^"]*)")\s*,\s*focal:\s*(?:'([^']*)'|"([^"]*)")\s*,\s*aperture:\s*(?:'([^']*)'|"([^"]*)")\s*\}/g;

const RUST_ENTRY_RE =
  /LensPreset\s*\{\s*name:\s*"([^"]*)"\s*\.to_string\(\)\s*,\s*focal:\s*"([^"]*)"\s*\.to_string\(\)\s*,\s*aperture:\s*"([^"]*)"\s*\.to_string\(\)\s*,?\s*\}/g;

/**
 * 从 `lensPresets.ts` 解析 `BUILTIN_LENS_PRESETS`。返回 `{ presets, problems }`。
 * 纯函数：`problems` 非空时 `presets` 无意义，判定层直接判红。
 */
export function parseTsLensPresets(source) {
  const block = source.match(
    /export\s+const\s+BUILTIN_LENS_PRESETS\b[\s\S]*?\[([\s\S]*?)\]\s*;/,
  );
  if (!block) {
    return {
      presets: [],
      problems: ['TS 里解析不到 `export const BUILTIN_LENS_PRESETS`（`lensPresets.ts`）'],
    };
  }
  const presets = [];
  for (const match of block[1].matchAll(TS_ENTRY_RE)) {
    presets.push({
      name: match[1] ?? match[2] ?? '',
      focal: match[3] ?? match[4] ?? '',
      aperture: match[5] ?? match[6] ?? '',
    });
  }
  if (presets.length === 0) {
    return {
      presets,
      problems: ['TS `BUILTIN_LENS_PRESETS` 数组里解析不到条目（`lensPresets.ts`）'],
    };
  }
  return { presets, problems: [] };
}

/**
 * 从 `models.rs`（façade）或其 `models/` 域文件解析 `builtin_lens_presets()`。返回 `{ presets, problems }`。
 */
export function parseRustLensPresets(source) {
  const start = source.search(/pub\s+fn\s+builtin_lens_presets\b/);
  if (start === -1) {
    return {
      presets: [],
      problems: [`Rust 里解析不到 \`pub fn builtin_lens_presets\`（${RUST_LABEL}）`],
    };
  }
  const suffix = source.slice(start);
  const end = suffix.indexOf('\n}\n');
  const body = end === -1 ? suffix : suffix.slice(0, end);
  const presets = [];
  for (const match of body.matchAll(RUST_ENTRY_RE)) {
    presets.push({ name: match[1], focal: match[2], aperture: match[3] });
  }
  if (presets.length === 0) {
    return {
      presets,
      problems: [`Rust \`builtin_lens_presets()\` 里解析不到条目（${RUST_LABEL}）`],
    };
  }
  return { presets, problems: [] };
}

/**
 * 定位 `pub fn builtin_lens_presets` 实际所在文件。issue #145 拆分后该函数在
 * `models/settings.rs`，façade `models.rs` 只 re-export——两者都扫，命中且仅命中
 * 一个文件才交给解析层；0 处 / 多处都交由调用方判红。返回路径数组（相对 root）。
 */
export function findRustLensPresetsPaths({
  root = ROOT,
  read = (path) => readFileSync(path, 'utf8'),
  list = (dir) => readdirSync(dir),
} = {}) {
  const candidates = [join(root, RUST_REL)];
  try {
    for (const name of list(join(root, RUST_DOMAIN_DIR))) {
      if (name.endsWith('.rs')) candidates.push(join(root, RUST_DOMAIN_DIR, name));
    }
  } catch {
    /* models/ 尚未拆出时只有 façade */
  }
  const found = [];
  for (const path of candidates) {
    let source;
    try {
      source = read(path);
    } catch {
      continue;
    }
    if (/pub\s+fn\s+builtin_lens_presets\b/.test(source)) found.push(path);
  }
  return found;
}

/**
 * 一致性判定：返回 `{ ok, message }`。纯函数，便于单测与变异。
 *
 * `ts` / `rust` 形如 `parseTsLensPresets` / `parseRustLensPresets` 的返回。
 */
export function judgeLensParity({ ts, rust }) {
  const problems = [];
  problems.push(...ts.problems);
  problems.push(...rust.problems);

  if (problems.length === 0) {
    const tsList = ts.presets;
    const rustList = rust.presets;
    if (tsList.length !== rustList.length) {
      problems.push(
        `条数不一致：TS ${tsList.length} 条、Rust ${rustList.length} 条` +
          `（lensPresets.ts / ${RUST_LABEL}）`,
      );
    }
    const count = Math.max(tsList.length, rustList.length);
    for (let index = 0; index < count; index++) {
      const tsItem = tsList[index];
      const rustItem = rustList[index];
      if (!tsItem) {
        problems.push(
          `第 ${index + 1} 条 Rust 独有：${JSON.stringify(rustItem)}（TS 缺这一条）`,
        );
        continue;
      }
      if (!rustItem) {
        problems.push(
          `第 ${index + 1} 条 TS 独有：${JSON.stringify(tsItem)}（Rust 缺这一条）`,
        );
        continue;
      }
      for (const field of ['name', 'focal', 'aperture']) {
        if (tsItem[field] !== rustItem[field]) {
          problems.push(
            `第 ${index + 1} 条 ${field} 不一致：TS \`${tsItem[field]}\` 与 Rust \`${rustItem[field]}\`` +
              `（lensPresets.ts / ${RUST_LABEL}）`,
          );
        }
      }
    }
  }

  if (problems.length === 0) {
    return {
      ok: true,
      message:
        `PASS: 出厂镜头预设前后端一致（${ts.presets.length} 条，同名同焦段同光圈同序，issue #125）。`,
    };
  }

  return {
    ok: false,
    message:
      `FAIL: 出厂镜头预设前后端不一致（${problems.length} 处）：\n` +
      problems.map((problem) => `  - ${problem}`).join('\n') +
      '\n  处置：确认哪一侧是新出厂表，把 `src/utils/lensPresets.ts` 的 ' +
      '`BUILTIN_LENS_PRESETS` 与后端的 `builtin_lens_presets()` ' +
      '同步到同值同序，别只改一边。单存（共享 JSON）另开 issue。',
  };
}

/** 读盘这一层：解析两处并判定，返回 `{ ok, message }`。 */
export function checkLensParity({
  root = ROOT,
  read = (path) => readFileSync(path, 'utf8'),
  list = (dir) => readdirSync(dir),
} = {}) {
  const tsPath = join(root, TS_REL);
  let tsSource;
  try {
    tsSource = read(tsPath);
  } catch {
    return { ok: false, message: `FAIL: 读不到 ${relative(root, tsPath)}` };
  }
  const found = findRustLensPresetsPaths({ root, read, list });
  let rust;
  if (found.length !== 1) {
    rust = {
      presets: [],
      problems: [
        `Rust 里 \`pub fn builtin_lens_presets\` 命中 ${found.length} 处` +
          `（${RUST_LABEL}；应为恰好 1 处）`,
      ],
    };
  } else {
    rust = parseRustLensPresets(read(found[0]));
  }
  return judgeLensParity({ ts: parseTsLensPresets(tsSource), rust });
}

function main() {
  const { ok, message } = checkLensParity();
  (ok ? console.log : console.error)(message);
  return ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
