/**
 * 缩略图探键读数解析纯函数（issue #190 缺陷 B）。
 *
 * ## 防的是什么
 *
 * 旧读端正则（`run-inapp.mjs` 基线）：
 *
 * ```js
 * /读数 T3 异写法（\S+）直调返回 (\S+)/
 * ```
 *
 * 全角括号 `（）` 是字面量，两个 `\S+` 都跨不过空格：夹具 / 工作目录路径或
 * 返回文件名一旦含空格（Windows 用户名带空格很常见），整条 `match` 返回
 * `null`，T3 硬检查判红，且 phase 2 T7 的外部真值（expectThumb）注入失败。
 *
 * ## 口径
 *
 * 写端（`src/devtools/e2eRunner.ts`）同批发结构化形式：
 *
 * ```
 * >>> 读数 T3 alt=<异写法路径> ret=<缓存文件名>
 * ```
 *
 * 本函数优先按 `alt=` / `ret=` 键值对解析：`alt=` 吃到 ` ret=` 前，`ret=`
 * 吃到行尾，值内部允许空格；同时回落兼容旧全角括号形式（`异写法（<alt>）
 * 直调返回 <ret>`），避免历史日志 / 单段手动跑的旧格式直接落空。
 *
 * 纯函数：输入日志文本，输出 `{ alt, ret }` 或 `null`，不碰进程 / 文件系统，
 * 便于在没有真窗口的阶段用 vitest 打变异。
 */

/** 新结构化形式：`alt=<alt> ret=<ret>`，值允许含空格。 */
const KEY_VALUE_RE = /\balt=(.*?)\s+ret=(.*?)\s*$/;
/** 旧全角括号形式：`异写法（<alt>）直调返回 <ret>`，捕获组允许空格（非贪婪）。 */
const LEGACY_RE = /读数 T3 异写法（(.+?)）直调返回 (.+?)\s*$/;

/**
 * 从日志文本里取 T3 读数行并解析。
 *
 * @param {string} logText 场景日志（全量或单段拼接均可）。
 * @returns {{ alt: string, ret: string } | null}
 *   解析不到 T3 读数行，或行内两个值都取不到时返回 `null`；`alt` 缺失时
 *   返回空串（旧形式只锁 ret 也够用，ret 是 T7 的外部真值，必须取到）。
 */
export function parseT3Reading(logText) {
  const text = String(logText ?? '');
  const line = text.split(/\r?\n/).find((l) => l.includes('读数 T3'));
  if (!line) return null;

  const kv = line.match(KEY_VALUE_RE);
  if (kv) {
    const ret = kv[2].trim();
    if (!ret) return null;
    return { alt: kv[1].trim(), ret };
  }

  const legacy = line.match(LEGACY_RE);
  if (legacy) {
    const ret = legacy[2].trim();
    if (!ret) return null;
    return { alt: legacy[1].trim(), ret };
  }

  return null;
}
