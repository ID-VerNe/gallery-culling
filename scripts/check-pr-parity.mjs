/**
 * 「本地绿」必须在 CI 等价条件下复现（issue #8，移植 IdleJot #61）。
 *
 * 背景：PR 正文写着「本地全绿」、CI 却红在**另一处**，最常见的原因是本地 worktree 继承了
 * 主工作区的状态。本仓只有两处「本地有、CI 没有」，而且都被 gitignore：
 *  - `node_modules/`：CI 用 `npm ci` 按 lockfile 重装；
 *  - `src-tauri/binaries/`：184MB sidecar，CI 只造 1 个占位文件。
 * 所以这里不剥环境变量（本仓没有私有库开关可剥），而是把复跑挪到**被推送那个 sha 的
 * 干净检出**里：
 *
 *  1. `git worktree add --detach <临时目录>/pristine <sha>`：只有该 sha 的已跟踪文件；
 *  2. 注入 `node_modules`（链接调用方的那一份，省一次 `npm ci`）——它是**同一份 lockfile
 *     的产物**，不携带工作区未提交的源码，不影响等价性；链接不成（调用方没装齐依赖）
 *     直接判环境问题退出 2，**不**降级成「没有依赖照样跑」，否则红的是环境不是代码；
 *  3. `src-tauri/binaries/` **不注入**：这正是 CI 与本地最容易分叉的地方（本地有全量
 *     sidecar，CI 只有占位文件），若被运行的用例真的依赖它，就应该在这里红出来；
 *  4. 用**该 sha 自己那份** `scripts/run-gates.mjs` + `gates.json` 执行（清单是被跑对象
 *     的一部分，别用当前工作区的清单去跑别的 sha）；
 *  5. 退出码：0 全绿 / 1 有门禁红 / 2 环境问题（ref 解析不了、worktree 建不起、未知分片）。
 *
 *     node scripts/check-pr-parity.mjs                    # 当前 HEAD 全量
 *     node scripts/check-pr-parity.mjs --shard static     # 只跑一片（较快）
 *     node scripts/check-pr-parity.mjs --ref origin/master --keep
 *
 * `.githooks/pre-push` 对每个被推送的本地 sha 跑一次；`SKIP_PARITY=1` 显式跳过（钩子留痕）。
 * CI 自己**不跑**本脚本：CI 已经是那个干净环境，而且它需要完整的 git 历史。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const git = (args, cwd = ROOT) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** 把 ref 解析成 commit sha；解析不了返回 null。 */
export function resolveRef(ref, cwd = ROOT) {
  try {
    return git(['rev-parse', '--verify', `${ref}^{commit}`], cwd);
  } catch {
    return null;
  }
}

/** 校验分片名用的是**被跑 sha 自己那份**清单；合法返回 null。纯函数，供单测。 */
export function shardProblem(manifest, shard) {
  const names = (manifest?.shards ?? []).map((row) => row.name);
  if (shard === null || shard === undefined) {
    if (names.length === 0) return '该 sha 的 scripts/gates.json 没有任何分片';
    return null;
  }
  if (names.includes(shard)) return null;
  return `未知分片 ${JSON.stringify(shard)}；该 sha 的合法值：${names.join('、') || '(无)'}`;
}

/** 该 sha 的检出里缺什么才能跑门禁：返回缺失的路径列表（空 = 可跑）。纯函数，供单测。 */
export function missingInputs(pristine, { exists = existsSync } = {}) {
  const needed = ['scripts/gates.json', 'scripts/run-gates.mjs'];
  return needed.filter((rel) => !exists(join(pristine, rel)));
}

/**
 * 在干净检出里链接 `node_modules`。
 *
 * Windows 上目录联接（junction）不需要管理员权限，`symlinkSync` 默认会要求开发者模式；
 * 所以优先 junction（`type: 'junction'` 在 win32 上就是 reparse point），其余平台普通软链。
 *
 * 链接失败**是环境问题**，不是「门禁会自己红」：干净检出里没有依赖时，红的是门禁本身
 * （缺陷）而不是被检查的代码，读者会把环境问题当成代码问题。调用方据此判退出码 2。
 * 返回 `{ linked, reason }`；`linked: false` 时 `reason` 是给人看的一句话。
 */
export function linkModules(pristine, source, platform = process.platform) {
  const target = join(pristine, 'node_modules');
  if (existsSync(target)) return { linked: false, reason: '干净检出里已经有 node_modules' };
  // 只判 source 目录存在是不够的：目录可能在、内容却是空（2026-11-02 实测 `npm ci` 装到
  // 一半中断就留下这种状态）。链接过去得到的是「目录在、内容空」的干净检出，
  // 前端门禁会以 `Cannot find package 'postcss'` 崩掉——那不是代码问题，是环境问题。
  if (!existsSync(join(source, 'postcss'))) {
    return { linked: false, reason: '调用方的 node_modules 里没有 postcss（依赖没装齐）' };
  }
  try {
    if (platform === 'win32') symlinkSync(source, target, 'junction');
    else symlinkSync(source, target, 'dir');
    return { linked: true, reason: null };
  } catch (error) {
    return { linked: false, reason: `链接失败：${error.message}` };
  }
}

/**
 * 拆掉 `linkModules` 造的那个链接，**只拆链接**。
 *
 * 2026-11-02 实测：主工作区的 `node_modules` 三次变成空目录，每次都紧跟在 parity 收尾之后，
 * 同一次故障里另一个 worktree 指向主工作区的目录联接也退化成空目录。机制没查清——单独
 * 试 `rmSync(..., { recursive: true })` 删联接、删含联接的父目录，都**没有**跟进目标——
 * 但这同样说明「递归删除」不是可以依赖的拆链接手段。`unlinkSync` 只删重解析点，语义上
 * 不碰目标内容，是这里唯一能证明无害的做法。
 *
 * 不是链接就不动：那不是我们造的，删不删由它的主人决定。
 */
export function unlinkModules(pristine) {
  const target = join(pristine, 'node_modules');
  try {
    if (!lstatSync(target).isSymbolicLink()) return;
  } catch {
    return; // 不存在（或读不了）：没什么可拆的。
  }
  unlinkSync(target);
}

function removeWorktree(path) {
  unlinkModules(path);
  try {
    git(['worktree', 'remove', '--force', path]);
  } catch {
    rmSync(path, { recursive: true, force: true });
  }
  try {
    git(['worktree', 'prune']);
  } catch {
    // prune 失败不影响判定：残留条目由下一次 `git worktree list` 暴露。
  }
}

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : (args[index + 1] ?? null);
}

export function main(argv, env = process.env) {
  const args = argv.slice(2);
  const ref = argValue(args, '--ref') ?? 'HEAD';
  const shard = argValue(args, '--shard');
  const keep = args.includes('--keep');

  const sha = resolveRef(ref);
  if (sha === null) {
    console.error(`FAIL: 解析不了 ref ${JSON.stringify(ref)}（先 fetch，或用完整 sha）`);
    return 2;
  }

  const scratch = mkdtempSync(join(tmpdir(), 'gallery-parity-'));
  const pristine = join(scratch, 'pristine');
  try {
    git(['worktree', 'add', '--detach', pristine, sha]);
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    console.error(`FAIL: 建不起 pristine worktree（${String(error.stderr ?? error.message).trim()}）`);
    return 2;
  }

  try {
    const missing = missingInputs(pristine);
    if (missing.length > 0) {
      console.error(`FAIL: ${sha.slice(0, 7)} 缺少 ${missing.join('、')}（清单与执行器是 parity 的入口）`);
      return 2;
    }
    const manifest = JSON.parse(readFileSync(join(pristine, 'scripts', 'gates.json'), 'utf8'));
    const problem = shardProblem(manifest, shard);
    if (problem !== null) {
      console.error(`FAIL: ${problem}`);
      return 2;
    }

    const link = linkModules(pristine, join(ROOT, 'node_modules'));
    console.log(`parity: ref ${sha.slice(0, 7)} → ${pristine}`);
    if (!link.linked) {
      // 没有依赖就跑门禁，红的是「干净检出缺环境」而不是被检查的代码。pre-push 会把
      // 这个当成「本地环境问题」而不是「这个 sha 有问题」，两者修法完全不同。
      console.error(
        `FAIL: 干净检出里装不了 node_modules（${link.reason}），没有完成 CI 等价复跑——这不是绿。\n` +
          '  修法：在当前工作区 `npm ci`（同一份 lockfile），或 SKIP_PARITY=1 git push（会留痕）。',
      );
      return 2;
    }
    console.log(
      'parity: node_modules 已从调用方链接（同一份 lockfile 的产物；src-tauri/binaries 不注入，与 CI 同形）',
    );

    const command = ['ci', ...(shard ? ['--shard', shard] : [])];
    const result = spawnSync(process.execPath, [join(pristine, 'scripts', 'run-gates.mjs'), ...command], {
      cwd: pristine,
      stdio: 'inherit',
      env,
    });
    if (result.error) {
      console.error(`FAIL: 起不了 gates 执行器（${result.error.message}）`);
      return 2;
    }
    const status = result.status ?? 2;
    if (status === 0) {
      console.log(`PASS: parity 通过（${shard ? `分片 ${shard}` : '全部分片'}，干净检出 + 同一份清单）`);
      return 0;
    }
    console.error(`FAIL: parity 未通过（干净检出里 run-gates.mjs 退出 ${status}）`);
    return status === 1 ? 1 : 2;
  } finally {
    if (keep) {
      console.log(`保留现场：worktree=${pristine}`);
    } else {
      removeWorktree(pristine);
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv));
}
