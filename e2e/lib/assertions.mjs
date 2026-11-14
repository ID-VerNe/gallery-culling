/**
 * 真窗口 e2e 场景的「期望断言集合」校验纯函数（issue #188）。
 *
 * ## 防的是什么
 *
 * 旧编排器（`e2e/run-inapp.mjs` 基线）只校验「日志里**已经出现**的断言行是否都被
 * 解析为 true」，外加 `assertLines > 0`：一条断言因上游条件不满足而根本没下发时，
 * 出现数同步少 1，「解析数 == 出现数」仍成立 → 场景照样 EXIT=0 假绿。本模块把
 * 校验方向反过来：按场景点名「**应该**出现哪些断言行」，缺一条即红。
 *
 * ## 为什么是「必备子集 + anyOf 分支 + 条件跳过白名单 + 下限」，而不是严格集合相等
 *
 * - 本 issue 的缺陷方向是「少发一条」，必备子集按 token 点名正好钉住缺失；
 * - 严格相等额外要求「不多发」，但 `render-export` 有引擎可用 / 不可用两条互斥
 *   分支（R6/R7 ↔ R8/R9/R10），D6/E6/T7 有运行时降级分支，严格相等会在合法分支
 *   上假红，反过来逼人放宽；
 * - 下限（`minCount`）只兜底「只剩一条也绿」，点名缺失仍靠名集合。
 *
 * 纯函数：输入日志文本 + 期望表，输出结构化判定，不碰进程 / 文件系统，便于在没有
 * 真窗口的阶段用 vitest 打变异。
 */

/** 断言行：`>>> 断言<token> … = true|false`（`=` 前允许无空格，沿用基线口径）。 */
const ASSERTION_RE = />>> (断言\S+)[^\n]*?= (true|false)/g;
/** 显式跳过行：`>>> 断言<token> 跳过（原因：…）`，不带 `= true|false`。 */
const SKIP_RE = />>> 断言(\S+)\s*跳过[（(]/g;
/** 断言行计数（含跳过行），沿用基线 `>>> 断言` 口径。 */
const RAW_LINE_RE = />>> 断言/g;

/**
 * 每个场景的期望表。token 与 `src/devtools/e2eRunner.ts` 里 `>>> 断言<token>`
 * 逐字对应；标准跑法（夹具在位、两段进程注入期望值）下：
 *
 * - `required`：必须出现的断言行，缺一条即红；
 * - `conditional`：条件降级断言 —— 出现断言行**或**出现显式跳过行都算满足，
 *   两者皆无才红（静默跳过是 issue #188 堵的缺口）；
 * - `anyOf`：互斥结果分支分组，至少命中一组（组内 token 任一即可）；
 * - `minCount`：解析到的 true/false 断言行下限（兜底「只剩一条也绿」）。
 *
 * 注意：`render-export` 的 R1–R6 与 `ui-contract` 的 R1–R6 同名不同义，表按场景
 * 隔离，不跨场景比对。
 */
export const EXPECTED_ASSERTIONS = {
  'render-export': {
    required: ['R1', 'R2', 'R3', 'R4', 'R5', 'R12', 'R11'],
    conditional: [],
    anyOf: [
      ['R6', 'R7'],
      ['R8', 'R9', 'R10'],
    ],
    minCount: 7,
  },
  'lumen-preset': {
    required: ['A1', 'A2', 'A3', 'B1'],
    conditional: [],
    anyOf: [],
    minCount: 4,
  },
  // 真机基线（2026-11-14，e2e/.tmp/baseline/detail-1to1-baseline.log）：16 条全发。
  // 注意：D4（首次 ≤10s）/D14（重渲 <12s）在本机 debug 构建下两次复跑均超时
  // （13.5s/27.3s、63s），属既有环境时序抖动，不在本 lane 修；token 集合不受影响。
  'detail-1to1': {
    required: [
      'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'C-1', 'C-2', 'D8', 'D9', 'D10',
      'D11', 'D12', 'D13', 'D14',
    ],
    conditional: [],
    anyOf: [],
    minCount: 16,
  },
  'ui-contract': {
    required: [
      'U0', 'U1', 'U2', 'U2b', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8',
      'U17', 'U18', 'U19',
      'U9', 'U10', 'U11', 'U12', 'U12b', 'U12c', 'U13',
      'G100-1', 'G100-2', 'G100-3',
      'R1', 'R2', 'R3', 'R4', 'R5', 'R6',
      'U14',
      'G99-1', 'G99-2', 'G99-3', 'G99-4', 'G99-5', 'G99-6',
      'U15', 'U16',
      'G105-1', 'G105-2', 'G105-3', 'G105-4', 'G105-5', 'G105-6', 'G105-7', 'G105-8',
    ],
    conditional: [],
    anyOf: [],
    minCount: 46,
  },
  'external-fallback': {
    required: ['F1', 'F2', 'F2b', 'F3'],
    conditional: [],
    anyOf: [],
    minCount: 4,
  },
  // 真机基线：坏引擎服务下重试按钮存在，E6 照常发射（6 条全发）。
  'engine-download': {
    required: ['E1', 'E2', 'E3', 'E4', 'E5', 'E6'],
    conditional: [],
    anyOf: [],
    minCount: 6,
  },
  'session-restore': {
    required: ['S1', 'S2', 'S4', 'S5', 'S7', 'S7b', 'S8', 'S9'],
    conditional: [],
    anyOf: [],
    minCount: 8,
  },
  'thumb-cache': {
    required: ['T1', 'T3', 'T4', 'T5'],
    conditional: ['T7'],
    anyOf: [],
    minCount: 4,
  },
  // 设计上只发读数、不发断言行的场景；下限 0，不参与名集合比对。
  'load-photos': {
    required: [],
    conditional: [],
    anyOf: [],
    minCount: 0,
  },
};

/** 取场景期望表；未登记场景返回 `null`（调用方回退旧口径）。 */
export function expectedForScenario(scenario) {
  return EXPECTED_ASSERTIONS[scenario] ?? null;
}

/**
 * 解析日志文本。
 *
 * @returns {{ asserts: Array<{token:string,value:string}>, skipped: string[], rawLines: number }}
 *   `asserts` 为解析到 true/false 的断言行；`skipped` 为显式「跳过」行的 token；
 *   `rawLines` 为全部 `>>> 断言` 行数（含跳过行）。
 */
export function parseAssertionLines(logText) {
  const text = String(logText ?? '');
  const asserts = [...text.matchAll(ASSERTION_RE)].map((m) => ({
    token: m[1].replace(/^断言/, ''),
    value: m[2],
  }));
  const skipped = [...text.matchAll(SKIP_RE)].map((m) => m[1]);
  const rawLines = (text.match(RAW_LINE_RE) || []).length;
  return { asserts, skipped, rawLines };
}

/**
 * 按场景期望表判定日志是否齐全。
 *
 * @param {string} logText 场景全量日志（两段进程场景为两段拼接）。
 * @param {string} scenario 场景名。
 * @param {object} [expected] 期望表条目；缺省按场景名从 `EXPECTED_ASSERTIONS` 取。
 * @returns {{
 *   present: string[], missing: string[], missingConditional: string[],
 *   branchMissing: string[][], branchHit: boolean[], falseTokens: string[],
 *   skipped: string[], parsedCount: number, rawLines: number, ok: boolean,
 * }}
 *   `branchHit` 与 `branchMissing` 与 `anyOf` 各组一一对应；`anyOf` 是**互斥分支**
 *   （如引擎可用 / 不可用），至少命中一组即可。`ok` 为真当且仅当：必备齐全、条件项
 *   均有断言或跳过行、任一互斥分支组命中、无 false 断言、解析数达到下限。
 */
export function evaluateExpectedAssertions(logText, scenario, expected) {
  const entry = expected ?? expectedForScenario(scenario);
  const { asserts, skipped, rawLines } = parseAssertionLines(logText);
  const present = new Set(asserts.map((a) => a.token));
  const skippedSet = new Set(skipped);
  const falseTokens = asserts.filter((a) => a.value === 'false').map((a) => a.token);

  const required = entry?.required ?? [];
  const conditional = entry?.conditional ?? [];
  const anyOf = entry?.anyOf ?? [];
  const minCount = entry?.minCount ?? 0;

  const missing = required.filter((t) => !present.has(t));
  const missingConditional = conditional.filter(
    (t) => !present.has(t) && !skippedSet.has(t),
  );
  const branchHit = anyOf.map((group) => group.some((t) => present.has(t)));
  const branchMissing = anyOf.filter((_, i) => !branchHit[i]);
  const branchOk = anyOf.length === 0 || branchHit.some(Boolean);

  const ok =
    missing.length === 0 &&
    missingConditional.length === 0 &&
    branchOk &&
    falseTokens.length === 0 &&
    asserts.length >= minCount;

  return {
    present: [...present],
    missing,
    missingConditional,
    branchMissing,
    branchHit,
    falseTokens,
    skipped,
    parsedCount: asserts.length,
    rawLines,
    ok,
  };
}
