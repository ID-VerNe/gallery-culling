/**
 * `cargo fmt` 基线守卫（issue #6，对应 AGENTS 红线 2）。
 *
 * 本仓基线里**刻意**保留着一批格式差异（`gates.json` 的 `fmtBaseline`）。原因是
 * 裸跑 `cargo fmt` 会把整个 crate 重排一遍，把真实改动埋进几千行无意义的 diff 里，
 * review 与 `git blame` 一起废掉。以前这条只能靠人肉
 * `cargo fmt --check 2>&1 | grep -c "^Diff in"` 再心算，现在变成门禁：
 *
 * - 差异处数 **> 基线** → 红（你要么裸跑了 fmt，要么新代码没对齐）；
 * - 差异处数 **< 基线** → 绿，但打印提醒下调基线（顺手修好了就该记下来，
 *   否则下次真正的回归会被这份余量吃掉）。
 *
 * 新文件可以单独 `rustfmt --edition 2021 <file>`，只碰它自己。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 只数 rustfmt 的差异头（`Diff in <path> at line N:` / `Diff in <path>:N:`）。
 *
 * 刻意用 `startsWith` 而不是 `includes`：差异块里完全可能出现一行内容本身含
 * 「Diff in」字样的代码或字符串，`includes` 会把它多算一处，让基线慢慢漂上去。
 */
export function countFmtDiffs(output) {
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith('Diff in')).length;
}

/** 判定：`{ ok, message }`。纯函数，便于单测与变异。 */
export function judgeFmt(diffs, baseline) {
  if (diffs > baseline) {
    return {
      ok: false,
      message:
        `FAIL: cargo fmt 差异 ${diffs} 处 > 基线 ${baseline} 处。\n` +
        '  大概率是裸跑了 `cargo fmt`（会重排整个 crate，把真实改动埋掉）。\n' +
        '  处置：先 `git checkout -- src-tauri/src` 撤回重排，再只对齐自己新写的段落；\n' +
        '  新文件可以单独 `rustfmt --edition 2021 <file>`。确认要抬高基线时改 gates.json 的 fmtBaseline 并说明原因。',
    };
  }
  if (diffs < baseline) {
    return {
      ok: true,
      message: `PASS: cargo fmt 差异 ${diffs} 处，低于基线 ${baseline} 处 —— 顺手修好了，请把 gates.json 的 fmtBaseline 下调到 ${diffs}。`,
    };
  }
  return { ok: true, message: `PASS: cargo fmt 差异 ${diffs} 处，与基线一致。` };
}

function main() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'scripts', 'gates.json'), 'utf8'));
  const baseline = manifest.fmtBaseline;
  if (typeof baseline !== 'number') {
    console.error('FAIL: gates.json 缺少数字型 fmtBaseline');
    return 1;
  }

  const result = spawnSync('cargo', ['fmt', '--check'], {
    cwd: join(ROOT, 'src-tauri'),
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.error) {
    console.error(`FAIL: 跑不了 cargo fmt（${result.error.message}）——本门禁需要 Rust 工具链`);
    return 1;
  }

  // rustfmt 有差异时退出码就是 1，所以**只能看输出**，不能看退出码。
  const diffs = countFmtDiffs(`${result.stdout ?? ''}${result.stderr ?? ''}`);
  const verdict = judgeFmt(diffs, baseline);
  (verdict.ok ? console.log : console.error)(verdict.message);
  return verdict.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
