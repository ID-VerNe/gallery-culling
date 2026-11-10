/**
 * 水印预设名与尺寸四份一致（issue #126）。
 *
 * ## 防的是什么
 *
 * 水印预设名实际 4 份同值，改名或加名只改一边，前端先加一色：
 *
 * - 后端 `watermark.rs:57` `PRESET_NAMES` —— 导出真值，`resolve_watermark`
 *   （`commands/export.rs:849`）查它，未知名整批 `Err`（`export.rs:862`
 *   「未知的水印配色」），`export.rs:1754` 用例锁着整批失败；
 * - 后端 `watermark.rs:63-68` `parse()` 四个 match arm —— 同文件第 4 份，
 *   只改 `PRESET_NAMES` 而这里未同步同样整批拒绝；
 * - 前端 `exportConfig.ts:113-121` `WATERMARK_PRESETS` 四条 `value` ——
 *   注释已自述「后端整批拒绝，多一个名就意味着一种必然失败的导出」；
 * - 前端 `types/index.ts:271` `WatermarkPresetName` 联合类型 —— 类型层第 4 份。
 *
 * 尺寸同理三份：`watermark.rs:44-45` `SIZE_MIN/MAX`（8.0/35.0）、
 * `exportConfig.ts:129-131` `WATERMARK_SIZE_MIN/MAX/DEFAULT_WATERMARK_SIZE`
 * （8/35/14；Rust 侧无默认常量）。滑杆 `WatermarkOptions.tsx:114-115` 绑定
 * TS 常量、无硬编码，漂移面只在上述两处。
 *
 * 这类「改一处、他处静默错」只有机器比对能钉住。本门禁只**比对**，不建
 * JSON 单源、不改 Rust 常量值、不让 IPC 去查表 —— 单源是远期重构，另开 issue。
 *
 * ## 为什么尺寸要把 8/35/14 钉成字面量
 *
 * 名是「两边各自为政但必须逐字相等」的比对；尺寸的 8/35 还要与渲染器
 * `watermark.defaults()` 的 8–35% 逐字一致（`watermark.rs:43` 注释），默认
 * 14 也是用户在框里看到的初始值（滑杆落点、`border_width` 真机口径的基准）。
 * 显式把三值钉住后，有意改默认尺寸的人也会被这个门禁逼着同步改门禁与注释，
 * 而不是悄悄让默认值在两处之间分叉。
 *
 * `validate_size` 的钳制语义不在本门禁内（尺寸越界走 clamp、仅 NaN/Inf
 * 拒绝，单独 P2 问题）——门禁只断言常量相等，不碰钳制行为。
 *
 * 本脚本**不带 shebang**：首行 `#!` + CRLF 检出的 `.mjs` 会让 vitest
 * 模块管线吐无栈 SyntaxError（`AGENTS.md` §4），调用点全是显式 `node`。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const RUST_REL = join('src-tauri', 'src', 'watermark.rs');
const CONFIG_REL = join('src', 'components', 'export', 'exportConfig.ts');
const TYPES_REL = join('src', 'types', 'index.ts');

/** 与渲染器契约逐字一致的尺寸（`watermark.rs:43-45` 注释「8–35% 逐字一致」）。 */
export const EXPECTED_SIZE_MIN = 8;
export const EXPECTED_SIZE_MAX = 35;
export const EXPECTED_SIZE_DEFAULT = 14;

/** 从 Rust 源码解析 `PRESET_NAMES` 数组字面量。返回 `{ names, problems }`。 */
export function parseRustPresetNames(source) {
  const match = source.match(
    /pub\s+const\s+PRESET_NAMES\s*:\s*\[&str;\s*\d+\]\s*=\s*\[([^\]]*)\]/,
  );
  if (!match) {
    return {
      names: null,
      problems: ['Rust 里解析不到 `pub const PRESET_NAMES`（`watermark.rs`）'],
    };
  }
  const names = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (names.length === 0) {
    return {
      names,
      problems: ['Rust 的 `PRESET_NAMES` 解析出 0 个名字（`watermark.rs:57`？）'],
    };
  }
  return { names, problems: [] };
}

/**
 * 从 `parse()` 函数体里解析四个 match arm 的字面量。
 * 只在 `pub fn parse` 与 `pub fn as_str` 之间切片，`as_str` 的
 * `Self::Gallery => "gallery"` 与本正则方向相反，不会被误抓。
 */
export function parseRustParseArms(source) {
  const start = source.indexOf('pub fn parse(name: &str)');
  const end = source.indexOf('pub fn as_str');
  if (start === -1 || end === -1 || end < start) {
    return {
      names: null,
      problems: ['Rust 里定位不到 `WatermarkPreset::parse` 函数体（`watermark.rs:63`）'],
    };
  }
  const body = source.slice(start, end);
  const names = [...body.matchAll(/"([^"]+)"\s*=>\s*Some\(Self::([A-Za-z]+)\)/g)].map(
    (m) => m[1],
  );
  if (names.length === 0) {
    return {
      names,
      problems: ['`parse()` 里解析不到 4 个 match arm（`watermark.rs:63-68`？）'],
    };
  }
  return { names, problems: [] };
}

/** 从 Rust 源码解析 `SIZE_MIN` / `SIZE_MAX`。返回 `{ min, max, problems }`。 */
export function parseRustSizes(source) {
  const minMatch = source.match(/pub\s+const\s+SIZE_MIN\s*:\s*f32\s*=\s*([0-9]+(?:\.[0-9]+)?)/);
  const maxMatch = source.match(/pub\s+const\s+SIZE_MAX\s*:\s*f32\s*=\s*([0-9]+(?:\.[0-9]+)?)/);
  const problems = [];
  if (!minMatch) {
    problems.push('Rust 里解析不到 `pub const SIZE_MIN`（`watermark.rs:44`）');
  }
  if (!maxMatch) {
    problems.push('Rust 里解析不到 `pub const SIZE_MAX`（`watermark.rs:45`）');
  }
  return {
    min: minMatch ? Number(minMatch[1]) : null,
    max: maxMatch ? Number(maxMatch[1]) : null,
    problems,
  };
}

/** 从 `exportConfig.ts` 解析 `WATERMARK_PRESETS` 的 `value` 列表。 */
export function parseTsPresets(source) {
  const start = source.indexOf('export const WATERMARK_PRESETS');
  const end = start === -1 ? -1 : source.indexOf('];', start);
  if (start === -1 || end === -1) {
    return {
      names: null,
      problems: ['TS 里定位不到 `WATERMARK_PRESETS` 数组（`exportConfig.ts:113`）'],
    };
  }
  const body = source.slice(start, end);
  const names = [...body.matchAll(/value:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  if (names.length === 0) {
    return {
      names,
      problems: ['`WATERMARK_PRESETS` 里解析不到 `value`（`exportConfig.ts:113-121`？）'],
    };
  }
  return { names, problems: [] };
}

/** 从 `types/index.ts` 解析 `WatermarkPresetName` 联合类型的字面量。 */
export function parseTsPresetNameType(source) {
  const match = source.match(/export\s+type\s+WatermarkPresetName\s*=\s*([^;]+);/);
  if (!match) {
    return {
      names: null,
      problems: ['TS 里解析不到 `export type WatermarkPresetName`（`types/index.ts:271`）'],
    };
  }
  const names = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (names.length === 0) {
    return {
      names,
      problems: ['`WatermarkPresetName` 里解析不到字面量（`types/index.ts:271`？）'],
    };
  }
  return { names, problems: [] };
}

/** 从 `exportConfig.ts` 解析三个尺寸常量。返回 `{ min, max, def, problems }`。 */
export function parseTsSizes(source) {
  const read = (name) => {
    const m = source.match(
      new RegExp(`export\\s+const\\s+${name}\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)`),
    );
    return m ? Number(m[1]) : null;
  };
  const min = read('WATERMARK_SIZE_MIN');
  const max = read('WATERMARK_SIZE_MAX');
  const def = read('DEFAULT_WATERMARK_SIZE');
  const problems = [];
  if (min === null) {
    problems.push('TS 里解析不到 `WATERMARK_SIZE_MIN`（`exportConfig.ts:129`）');
  }
  if (max === null) {
    problems.push('TS 里解析不到 `WATERMARK_SIZE_MAX`（`exportConfig.ts:130`）');
  }
  if (def === null) {
    problems.push('TS 里解析不到 `DEFAULT_WATERMARK_SIZE`（`exportConfig.ts:131`）');
  }
  return { min, max, def, problems };
}

/** 集合相等判定（并报重复）。返回差异描述数组，空数组即相等。 */
function setDifferences(a, b, aLabel, bLabel) {
  const diffs = [];
  if (!a || !b) return diffs;
  const aSet = new Set(a);
  const bSet = new Set(b);
  if (aSet.size !== a.length) {
    const dup = [...a].filter((x, i) => a.indexOf(x) !== i)[0];
    diffs.push(`${aLabel} 内部有重复名 \`${dup}\``);
  }
  if (bSet.size !== b.length) {
    const dup = [...b].filter((x, i) => b.indexOf(x) !== i)[0];
    diffs.push(`${bLabel} 内部有重复名 \`${dup}\``);
  }
  for (const name of aSet) {
    if (!bSet.has(name)) {
      diffs.push(`${aLabel} 有 \`${name}\`，但 ${bLabel} 没有`);
    }
  }
  for (const name of bSet) {
    if (!aSet.has(name)) {
      diffs.push(`${bLabel} 有 \`${name}\`，但 ${aLabel} 没有`);
    }
  }
  return diffs;
}

/**
 * 一致性判定：返回 `{ ok, message }`。纯函数，便于单测与变异。
 *
 * `rust = { names, parseArms, min, max, problems }`、
 * `ts = { presets, typeNames, min, max, def, problems }`，解析失败时
 * `problems` 非空，对应字段无意义，判定层直接判红，不拿半份数据比对。
 */
export function judgeWatermark({ rust, ts }) {
  const problems = [];
  problems.push(...rust.problems, ...ts.problems);

  // 名：四份逐字相等（PRESET_NAMES / parse 臂 / WATERMARK_PRESETS / 联合类型）。
  const lists = [
    [rust.names, 'Rust `PRESET_NAMES`'],
    [rust.parseArms, 'Rust `parse()` 的 match arm'],
    [ts.presets, 'TS `WATERMARK_PRESETS`'],
    [ts.typeNames, 'TS `WatermarkPresetName`'],
  ];
  for (let i = 0; i < lists.length; i++) {
    for (let j = i + 1; j < lists.length; j++) {
      problems.push(...setDifferences(lists[i][0], lists[j][0], lists[i][1], lists[j][1]));
    }
  }

  // 尺寸：两边常量相等，且钉住渲染器契约值 8/35 与默认值 14。
  if (rust.min !== null && ts.min !== null) {
    if (rust.min !== ts.min) {
      problems.push(
        `尺寸下限不一致：Rust \`SIZE_MIN\` ${rust.min} vs TS \`WATERMARK_SIZE_MIN\` ${ts.min}`,
      );
    }
    if (rust.min !== EXPECTED_SIZE_MIN) {
      problems.push(
        `Rust \`SIZE_MIN\` 是 ${rust.min}，与渲染器契约 ${EXPECTED_SIZE_MIN} 不符（\`watermark.rs:44\`）`,
      );
    }
    if (ts.min !== EXPECTED_SIZE_MIN) {
      problems.push(
        `TS \`WATERMARK_SIZE_MIN\` 是 ${ts.min}，与渲染器契约 ${EXPECTED_SIZE_MIN} 不符（\`exportConfig.ts:129\`）`,
      );
    }
  }
  if (rust.max !== null && ts.max !== null) {
    if (rust.max !== ts.max) {
      problems.push(
        `尺寸上限不一致：Rust \`SIZE_MAX\` ${rust.max} vs TS \`WATERMARK_SIZE_MAX\` ${ts.max}`,
      );
    }
    if (rust.max !== EXPECTED_SIZE_MAX) {
      problems.push(
        `Rust \`SIZE_MAX\` 是 ${rust.max}，与渲染器契约 ${EXPECTED_SIZE_MAX} 不符（\`watermark.rs:45\`）`,
      );
    }
    if (ts.max !== EXPECTED_SIZE_MAX) {
      problems.push(
        `TS \`WATERMARK_SIZE_MAX\` 是 ${ts.max}，与渲染器契约 ${EXPECTED_SIZE_MAX} 不符（\`exportConfig.ts:130\`）`,
      );
    }
  }
  if (ts.def !== null && ts.min !== null && ts.max !== null) {
    if (ts.def !== EXPECTED_SIZE_DEFAULT) {
      problems.push(
        `TS \`DEFAULT_WATERMARK_SIZE\` 是 ${ts.def}，与契约默认 ${EXPECTED_SIZE_DEFAULT} 不符（\`exportConfig.ts:131\`；有意改默认尺寸要在本门禁同步改此值）`,
      );
    }
    if (ts.def < ts.min || ts.def > ts.max) {
      problems.push(
        `TS \`DEFAULT_WATERMARK_SIZE\` ${ts.def} 落在区间 [${ts.min}, ${ts.max}] 之外（滑杆默认值画在开关外）`,
      );
    }
  }

  if (problems.length === 0) {
    return {
      ok: true,
      message:
        `PASS: 水印预设名与尺寸四份一致（${[...rust.names].join('//')}；` +
        `尺寸区间 ${rust.min}–${rust.max}、默认 ${ts.def}，issue #126）。`,
    };
  }

  return {
    ok: false,
    message:
      `FAIL: 水印预设名/尺寸四份不一致（${problems.length} 处）：\n` +
      problems.map((problem) => `  - ${problem}`).join('\n') +
      '\n  处置：预设名以 Rust `watermark.rs` 的 `PRESET_NAMES` 为真值，四处（' +
      '`PRESET_NAMES`、`parse()` 臂、`WATERMARK_PRESETS`、`WatermarkPresetName`）' +
      '必须逐字相等；尺寸以 `SIZE_MIN/MAX` 为准，TS 三常量要对齐 8/35/14。' +
      '别只改一边——后端对未知名是整批拒绝，没有静默回落可救。',
  };
}

/** 读盘这一层：解析三处并判定，返回 `{ ok, message }`。 */
export function checkWatermark({
  root = ROOT,
  read = (path) => readFileSync(path, 'utf8'),
} = {}) {
  const rustPath = join(root, RUST_REL);
  const configPath = join(root, CONFIG_REL);
  const typesPath = join(root, TYPES_REL);
  let rustSource;
  let configSource;
  let typesSource;
  try {
    rustSource = read(rustPath);
  } catch {
    return { ok: false, message: `FAIL: 读不到 ${relative(root, rustPath)}` };
  }
  try {
    configSource = read(configPath);
  } catch {
    return { ok: false, message: `FAIL: 读不到 ${relative(root, CONFIG_REL)}` };
  }
  try {
    typesSource = read(typesPath);
  } catch {
    return { ok: false, message: `FAIL: 读不到 ${relative(root, TYPES_REL)}` };
  }
  const rustNames = parseRustPresetNames(rustSource);
  const rustArms = parseRustParseArms(rustSource);
  const rustSizes = parseRustSizes(rustSource);
  const tsPresets = parseTsPresets(configSource);
  const tsType = parseTsPresetNameType(typesSource);
  const tsSizes = parseTsSizes(configSource);
  return judgeWatermark({
    rust: {
      names: rustNames.names,
      parseArms: rustArms.names,
      min: rustSizes.min,
      max: rustSizes.max,
      problems: [...rustNames.problems, ...rustArms.problems, ...rustSizes.problems],
    },
    ts: {
      presets: tsPresets.names,
      typeNames: tsType.names,
      min: tsSizes.min,
      max: tsSizes.max,
      def: tsSizes.def,
      problems: [...tsPresets.problems, ...tsType.problems, ...tsSizes.problems],
    },
  });
}

function main() {
  const { ok, message } = checkWatermark();
  (ok ? console.log : console.error)(message);
  return ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
