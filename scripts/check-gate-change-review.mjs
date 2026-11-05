/**
 * 门禁链改动必须在 PR 正文的 `## 门禁改动` 段逐个交代（issue #8，移植 IdleJot #62/#107/#324）。
 *
 * 背景：门禁是这套协作里唯一的第三方校验，但**被测方可以在同一个 PR 里改门禁脚本**——
 * 删弱断言后 CI 只看到绿色，没有任何东西拦得住。元门禁（check-gates-manifest.mjs）
 * 只管「清单与磁盘一致」，它能保证 `check-x.mjs` 存在，却不能保证它的断言没被改软。
 *
 *     node scripts/check-gate-change-review.mjs --base origin/master --body-file pr.md
 *     node scripts/check-gate-change-review.mjs --gate-changes        # 显式声明，不许 SKIP
 *
 * 判定链：
 *  1. 改动集 = `git diff --name-only <base>...HEAD`（三点，按 merge-base），只取门禁执行链：
 *     `scripts/check-*.mjs`、`scripts/gates.json`、`scripts/run-gates.mjs`、
 *     `.github/workflows/ci.yml`，外加 `.githooks/` 下全部钩子——改清单、执行器、
 *     workflow 或钩子与改断言等价（钩子是门禁执行入口）；
 *  2. 命中时正文必须有 `## 门禁改动` 段，且每个被改路径都**出现在该段内**（段外提到不算）；
 *  3. 段末必须有一条独立复核结论（`独立复核`：`APPROVE` / `APPROVED` / `REQUEST_CHANGES`）；
 *     `<PENDING>` / 空白 / `待复核` 一律红；
 *  4. 复核行之后不许再有实质内容——先写结论后补证据是**自审**的形状，不是复核的形状；
 *  5. 没有 PR 上下文（本机直跑）时 SKIP 并通过；显式声明 `--gate-changes` / `GATE_CHANGES=1`
 *     却拿不到 base 时 **fail-closed**（`base...HEAD` 在无 base 时会退化成空集，
 *     「直接推上来绕过 PR」的口子只能靠这条守）；
 *  6. `GATE_CHANGE_REVIEW_EVENT=push`（CI 显式注入事件类型）时是**落地事件**：push 上
 *     没有 PR 正文可读，改动已经过 PR 闸门 → 有 base 就列出命中的门禁链文件留痕后放行，
 *     无 base 也留痕放行；不因「没有 PR base」判红（issue #56）。
 *
 * **时点边界**：闸门上界是 `APPROVED_AT`。基线早于该时刻（或不可得）的 PR 属于
 * 「闸门建立之前」，复核行只提示不判红——#8 自身就是这种 PR，否则它会把自己打红。
 *
 * CI 由 `.github/workflows/ci.yml` 注入 `PR_BASE_SHA`（pull_request 用 base 分支 sha，
 * push 回退 `github.event.before`）、`PR_BODY` / `PR_NUMBER`（仅 pull_request 有值）、
 * `GATE_CHANGES`（push 事件为 `1`）与 `GATE_CHANGE_REVIEW_EVENT`（原始事件名）。
 *
 * 每条规则都有单测（scripts/gates.test.mjs），成对的「坏形态红 / 同形好形态绿」。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 门禁执行链。**新增或改名门禁脚本时必须同步这里**，否则披露要求会悄悄漏掉一整类文件。
 * `fnmatch` 的等价物：这里手写 glob——只支持 `*`（跨 `/`）与 `?`，够用且不引依赖。
 */
export const PATTERNS = [
  'scripts/check-*.mjs',
  'scripts/gates.json',
  'scripts/run-gates.mjs',
  '.github/workflows/ci.yml',
  '.githooks/*', // 钩子是门禁执行入口：改 pre-push 与改断言等价
];

/**
 * 独立复核闸门的生效上界。基线早于该时刻（或不可得）的 PR 属于「闸门建立之前」，
 * 复核行只提示不判红。**调低这个值会让历史 PR 集体变红**，只在明确要回溯时才改。
 */
export const APPROVED_AT = '2026-11-02T00:00:00Z';

export const SECTION_NAME = '门禁改动';
/** 结论按长到短排：`APPROVE` 是 `APPROVED` 的前缀，短串先判会把 APPROVED 认成 APPROVE。 */
export const VERDICTS = ['REQUEST_CHANGES', 'APPROVED', 'APPROVE'];

const HEADING = /^##[ \t]+门禁改动[ \t\r]*$/m;
const NEXT_HEADING = /^#{1,2}[ \t]+\S/m;
/** 复核结论行：行首（允许 markdown 列表符与加粗）以「独立复核」开头。 */
const REVIEW_LINE = /^\s*(?:[-*+]\s+)?\*{0,2}\s*独立复核/;
const DIVIDER = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
/** PR 正文的收尾链接行（`Refs #8`）：不带判据，可与分隔线同等看待。 */
const FOOTER_LINE = /^\s*(?:Refs|Closes|Fixes)\b/i;

/** glob 转正则：`**` / `*` 都跨 `/`（与 IdleJot 的 fnmatch 同口径），别在这里发明新语义。 */
export function globToRegExp(pattern) {
  let out = '';
  for (const char of pattern) {
    if (char === '*') out += '.*';
    else if (char === '?') out += '.';
    else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

const MATCHERS = PATTERNS.map(globToRegExp);

/** 只保留门禁执行链上的文件（顺序按 diff 输出，去重）。 */
export function gateChain(files) {
  const hit = [];
  for (const raw of files) {
    // git 在 Windows 上输出正斜杠，但手工传进来的路径可能是反斜杠：统一成 `/` 再比。
    const path = raw.trim().replace(/\\/g, '/');
    if (!path || hit.includes(path)) continue;
    if (MATCHERS.some((matcher) => matcher.test(path))) hit.push(path);
  }
  return hit;
}

/**
 * 取 `## 门禁改动` 段的直接内容（不含标题行本身）。
 *
 * 段到下一个**同级或更高级**标题（`#` / `##`）为止；段内的 `###` 子标题、引用块
 * 仍是本段——它们跟在段末的 `Refs #NN` 都是正文证据，不能排除在「复核行须在段末」之外。
 */
export function gateSection(body) {
  if (typeof body !== 'string') return null;
  const matched = HEADING.exec(body);
  if (!matched) return null;
  const text = body.slice(matched.index + matched[0].length);
  const next = NEXT_HEADING.exec(text);
  return next ? text.slice(0, next.index) : text;
}

/** 段里的独立复核结论行 → { line, verdict }；verdict 为 null 表示「还没贴出结论」。 */
export function reviewRecord(section) {
  if (section === null || section === undefined) return { line: null, verdict: null };
  for (const raw of section.split('\n')) {
    const line = raw.trim();
    if (!REVIEW_LINE.test(line)) continue;
    const upper = line.toUpperCase();
    const verdict = VERDICTS.find((item) => upper.includes(item)) ?? null;
    return { line, verdict };
  }
  return { line: null, verdict: null };
}

/**
 * 自审判据：复核行之后不许再有实质内容。返回第一处违规行（去空白），合规返回 null。
 * 段里没有复核行时也返回 null——缺结论由 reviewRecord 判，不在这里重复报。
 * 分隔线与纯 `Refs #NN` 收尾行不算实质内容：它们不带判据，也不构成证据。
 */
export function reviewOrderProblem(section) {
  if (section === null || section === undefined) return null;
  const lines = section.split('\n').map((line) => line.trim());
  const order = lines.flatMap((line, index) => (REVIEW_LINE.test(line) ? [index] : []));
  if (order.length === 0) return null;
  const tail = lines
    .slice(order[order.length - 1] + 1)
    .filter((line) => line && !DIVIDER.test(line) && !FOOTER_LINE.test(line));
  return tail.length > 0 ? tail[0] : null;
}

/** `2026-11-01T11:29:23+08:00` / `...Z` → 毫秒数；空值与坏值返回 null。 */
export function parseTime(text) {
  if (!text || typeof text !== 'string') return null;
  const stamp = Date.parse(text.trim());
  return Number.isNaN(stamp) ? null : stamp;
}

/** 闸门是否适用：基线时间不早于上界。基线不可得 → 不适用（不判红）。 */
export function gateApplies(baseIsoDate) {
  const stamp = parseTime(baseIsoDate);
  const limit = parseTime(APPROVED_AT);
  if (stamp === null || limit === null) return false;
  return stamp >= limit;
}

/**
 * 核心判定：门禁链命中文件 + PR 正文 → { code, lines }。
 *
 * `body` 为 null 表示正文**不可得**（与空串区分：空串是「有正文、没有段」）。
 * `gated` 表示独立复核闸门生效（见 gateApplies）。纯函数，供 main 与单测共用。
 */
export function judge(touched, body, gated = false) {
  const lines = [];
  const gateOn = gated && touched.length > 0;
  const section = gateSection(body);

  if (touched.length === 0) {
    lines.push(
      section === null
        ? '  ok  本次未触及门禁链，不需要 `## 门禁改动` 段'
        : '  ok  本次未触及门禁链；正文带 `## 门禁改动` 段（允许）',
    );
    return { code: 0, lines: [...lines, 'PASS: 门禁链无改动。'] };
  }

  if (body === null || body === undefined) {
    lines.push(`  FAIL 改动触及门禁链（${touched.length} 个文件），但拿不到 PR 正文`);
    lines.push('     CI 需注入 PR_BODY，本机用 --body-file');
    for (const path of touched) lines.push(`     需要交代：${path}`);
    return { code: 1, lines: [...lines, 'FAIL: 门禁改动段缺失（正文不可得）。'] };
  }

  if (section === null) {
    lines.push(`  FAIL 改动触及门禁链（${touched.length} 个文件），但正文没有 \`## ${SECTION_NAME}\` 段`);
    for (const path of touched) lines.push(`     需要交代：${path}`);
    return { code: 1, lines: [...lines, 'FAIL: 门禁改动段缺失。'] };
  }

  // 段内比对：路径大小写与反斜杠都归一，避免 Windows 上「写了但不认」。
  const normalized = section.replace(/\\/g, '/').toLowerCase();
  const missing = touched.filter((path) => !normalized.includes(path.toLowerCase()));
  if (missing.length > 0) {
    lines.push(`  FAIL \`## ${SECTION_NAME}\` 段漏列 ${missing.length} / ${touched.length} 个被改文件`);
    for (const path of missing) lines.push(`     漏列：${path}`);
    return { code: 1, lines: [...lines, 'FAIL: 门禁改动段没有逐个交代。'] };
  }
  for (const path of touched) lines.push(`  ok  已交代：${path}`);

  const { line: record, verdict } = reviewRecord(section);
  const orderTail = reviewOrderProblem(section);

  if (!gateOn) {
    const why = `闸门自 ${APPROVED_AT.slice(0, 10)} 起生效，本 PR 在之前`;
    if (record === null) lines.push(`  hint 段内没有独立复核结论行（${why}）`);
    else if (verdict === null) lines.push(`  hint 段内复核行还没贴出结论（${why}，放行）`);
    else if (orderTail) lines.push(`  hint 复核行之后还有实质内容（${why}，放行）`);
    else lines.push(`  ok  独立复核已贴：${verdict}`);
  } else {
    if (record === null) {
      lines.push('  FAIL `## 门禁改动` 段没有独立复核结论行（issue #8）');
      lines.push('     需要一行：`独立复核`：APPROVE / REQUEST_CHANGES + 复核证据；复核行放段末');
      return { code: 1, lines: [...lines, 'FAIL: 独立复核缺席（闸门未通过）。'] };
    }
    if (verdict === null) {
      lines.push(`  FAIL 独立复核仍是占位、没有结论：${record}`);
      lines.push('     只认 APPROVE / APPROVED / REQUEST_CHANGES；`<PENDING>` 不算复核');
      return { code: 1, lines: [...lines, 'FAIL: 独立复核尚未贴出结论（闸门未通过）。'] };
    }
    if (orderTail) {
      lines.push(`  FAIL 复核结论排在正文证据之前，后面还有：${orderTail}`);
      lines.push('     复核行须在段末：先摆改了什么 / 为什么改 / 三种组合证据，最后给结论');
      return { code: 1, lines: [...lines, 'FAIL: 复核结论顺序不对（自审形状，闸门未通过）。'] };
    }
    lines.push(`  ok  独立复核已贴：${verdict}`);
  }

  return {
    code: 0,
    lines: [...lines, `PASS: ${touched.length} 个门禁链改动都在 \`## ${SECTION_NAME}\` 段内。`],
  };
}

/** `base...HEAD`（三点，按 merge-base）的改动集；git 失败抛错（调用方转成 fail-closed）。 */
export function changedFiles(base, cwd = ROOT) {
  const stdout = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

/** base 提交的提交时间（ISO 8601）；拿不到时返回 null。 */
export function baseCommittedAt(base, cwd = ROOT) {
  try {
    const stdout = execFileSync('git', ['log', '-1', '--format=%cI', base, '--'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** 正文优先级：--body-file > PR_BODY_FILE > PR_BODY；都没有时返回 null（≠ 空串）。 */
export function bodyFrom(env, bodyFile) {
  if (bodyFile) return readFileSync(bodyFile, 'utf8');
  if (env.PR_BODY_FILE) return readFileSync(env.PR_BODY_FILE, 'utf8');
  return env.PR_BODY === undefined ? null : env.PR_BODY;
}

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : (args[index + 1] ?? null);
}

export function main(argv, env = process.env) {
  const args = argv.slice(2);
  const base = argValue(args, '--base') ?? env.PR_BASE_SHA ?? '';
  const declared = args.includes('--gate-changes') || env.GATE_CHANGES === '1';
  // 事件类型由 ci.yml 显式注入（issue #56）：push 是落地事件，没有 PR 正文可读。
  // 不靠 env 空值语义（push 上 `${{ github.event.pull_request.* }}` 求值为 ''，
  // 旧实现用 `=== undefined` / `body === null` 判定，永远进不了 push 分支）。
  const isPush = env.GATE_CHANGE_REVIEW_EVENT === 'push';

  if (isPush) {
    // push 上不做正文披露校验（披露在 PR 闸门完成），但必须留痕：不是静默 SKIP。
    console.log('  note push 事件：push 上无 PR 正文可读，门禁链改动的披露由 PR 闸门负责');
    if (base) {
      try {
        const touched = gateChain(changedFiles(base));
        if (touched.length === 0) {
          console.log(`     ${base.slice(0, 7)}...HEAD 门禁链无改动`);
        } else {
          console.log(`     ${base.slice(0, 7)}...HEAD 改动集含 ${touched.length} 个门禁链改动：`);
          for (const path of touched) console.log(`     ${path}`);
        }
      } catch (error) {
        console.log(`     无法计算 ${base}...HEAD 的改动集：${error.message.split('\n')[0]}`);
      }
    } else {
      console.log('     拿不到 base（github.event.before 不可得），改动集不可计算');
    }
    console.log('PASS: push 事件留痕后放行（门禁链改动的披露由 PR 闸门负责）。');
    return 0;
  }

  if (!base && !declared) {
    console.log('  SKIP 没有 PR base（本机直跑 / push 事件）：门禁改动段只在 PR 上校验');
    console.log('PASS: 非 PR 上下文，跳过门禁改动段校验。');
    return 0;
  }

  if (!base) {
    // 声明了改动却没有 base：改动集不可得 → 不知道改了什么 → 无法核对披露。fail-closed。
    console.log('  FAIL 显式声明了门禁链改动（GATE_CHANGES / --gate-changes），但没有 PR base');
    console.log('     改动集不可得 → 无法核对 `## 门禁改动` 段是否逐个交代；');
    console.log('     直接推 master 绕过 PR 时，请走 PR（CI 会注入 PR_BASE_SHA）');
    console.log('FAIL: 门禁改动段校验无法完成（fail-closed）。');
    return 1;
  }

  let touched;
  try {
    touched = gateChain(changedFiles(base));
  } catch (error) {
    console.log(`  FAIL 无法计算 ${base}...HEAD 的改动集：${error.message.split('\n')[0]}`);
    console.log('FAIL: 门禁改动段校验无法完成（fail-closed）。');
    return 1;
  }

  const stamp = baseCommittedAt(base);
  const gated = gateApplies(stamp);
  console.log(
    gated
      ? `  gate 独立复核闸门生效（基线提交于 ${(stamp ?? '').slice(0, 10)}，不早于 ${APPROVED_AT.slice(0, 10)}）`
      : `  gate 独立复核闸门不适用（基线早于 ${APPROVED_AT.slice(0, 10)} 或不可得），只提示`,
  );

  let body;
  try {
    body = bodyFrom(env, argValue(args, '--body-file'));
  } catch (error) {
    console.log(`  FAIL 读不到正文文件：${error.message}`);
    console.log('FAIL: 门禁改动段校验无法完成（fail-closed）。');
    return 1;
  }

  const { code, lines } = judge(touched, body, gated);
  for (const line of lines) console.log(line);
  return code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv));
}
