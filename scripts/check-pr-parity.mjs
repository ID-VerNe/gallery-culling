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
 *  2. 链接调用方那份 `node_modules` —— 它是**同一份 lockfile 的产物**，不携带工作区
 *     未提交的源码，不影响等价性；链接前按 `gates.json` 的 `node node_modules/…` 入口
 *     逐个探文件，探不到就是调用方没装齐。链接不成直接判环境问题退出 2，
 *     **不**降级成「没有依赖照样跑」，否则红的是环境不是代码；
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
import { loadManifest, toolFiles } from './run-gates.mjs';

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
 *
 * 判「装没装齐」的探针是 `contents`：只判 `source/postcss` 目录存在不够——`npm ci`
 * 装到一半中断会留下空目录。这里要的是**能证明包内容真的落盘**的文件，由调用方按
 * `gates.json` 里各条门禁的 `node node_modules/…` 入口推出来（见 `probeContents`）。
 * 默认值是 `probeContents(loadManifest())`：不传就是「按当前清单探」，单测传死值。
 */
export function linkModules(pristine, source, platform = process.platform, contents = probeContents()) {
  const target = join(pristine, 'node_modules');
  // 干净检出是 `git worktree add` 刚造出来的：已跟踪文件里没有 `node_modules`（它被 gitignore）。
  // 这里真有东西，只能是调用方自己灌进去的 —— 那种环境不是 CI 的形态，复跑结果不能拿来
  // 声称「CI 等价」。原样照跑不报错会更糟：绿了也说明不了问题。
  if (existsSync(target)) {
    return { linked: false, reason: '干净检出里本来不该有 node_modules（被 gitignore），却出现了' };
  }
  if (contents.length === 0) {
    // 清单里一条 `node node_modules/…` 门禁都没有时，没有可判的依据。说不出来就别说，
    // 但也不能假装验过 —— 照跑一个「不知道装没装齐」的环境，绿了同样说明不了问题。
    return { linked: false, reason: '推不出任何要探的包内文件（清单里没有 node 跑 node_modules 的门禁）' };
  }
  const missing = contents.filter((rel) => !existsSync(join(source, rel)));
  if (missing.length > 0) {
    return { linked: false, reason: `调用方的 node_modules 里找不到 ${missing.join('、')}（依赖没装齐）` };
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
 * 清单里每条「node 跑包内入口」的门禁各贡献一个必须是**文件**的路径。
 *
 * 与 `run-gates.mjs` 的 `missingTools` 同口径：那边查的是这些文件在不在，缺了就判红；
 * 这边查的是它们在不在**调用方**的 `node_modules` 里，缺了就别把干净检出接上去。
 * 两处看同一批证据（同一个 `toolFiles`），不会出现「runner 认为配齐了、parity 认为没配齐」。
 */
export function probeContents(manifest = loadManifest()) {
  const files = (manifest.ci ?? []).flatMap((row) =>
    toolFiles(row.cmd ?? []).map(({ file }) => file),
  );
  return [...new Set(files)].sort();
}

/**
 * 拆掉 `linkModules` 造的那个链接，**只拆链接**。
 *
 * 2026-11-02 实测的故障链（本机 Windows 11 + git-bash 下逐条复现过）：
 *
 *  1. 调用方的 `node_modules` 被链接进干净检出，干净检出里又是 `npm/vitest` 的大量
 *     ESM 解析 —— **链接被参考图处理时**就会出问题；
 *  2. 收尾时先 `git worktree remove` / `rmSync` 删干净检出，再删 scratch 父目录。
 *     含重解析点的目录被递归删除，删除器越过联接跟进到**目标**里删内容：
 *     调用方 `node_modules` 内容被清空，而联接本身还在；
 *  3. 父目录里那个空目录仍然存在，`rmSync(force)` 静默成功 —— 退出码 0，看不出任何异常；
 *  4. 下一个 worktree 若也链向同一个目标，看到的就是空目录；删它时那次删除又在目标上
 *     重新造出空目录 —— 所以「每次都是空的、每次删完又出现」。
 *
 * 因此收尾必须是：先 `lstat` 判是链接 → `unlinkSync` 只摘重解析点（不碰目标内容）→
 * 才让 git 去删目录。**不能**只用 `unlinkSync` 摘链接：摘掉后 git 的 `worktree remove`
 * 仍要删 `.git` 等已跟踪文件，工作树被删空时它会删几次后失败，`force` 覆盖不了这种
 * 「删不干净」的失败 —— 实测摘链接后整条 parity 变成环境错误。所以移除方式仍以
 * `git worktree remove --force` 为主，失败才退回递归删除。
 *
 * `lstat` 不会跟进重解析点，判链接是最安全的一步；不是链接就不动 —— 那不是我们造的。
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

/**
 * 删干净检出：先摘链接，再让 git 删目录。
 *
 * 顺序不能反：反了就会在删目录那一步跟进联接，把调用方 `node_modules` 掏空。
 * 顺序本身用注入的 `{ unlink, remove, prune }` 锁住（单测把调用记进数组比对）——
 * 直接调模块私有函数是测不到先后的。
 */
export function removeWorktree(path, steps = {}) {
  const unlink = steps.unlink ?? unlinkModules;
  const remove =
    steps.remove ??
    ((target) => {
      try {
        git(['worktree', 'remove', '--force', target]);
      } catch {
        rmSync(target, { recursive: true, force: true });
      }
    });
  const prune =
    steps.prune ??
    (() => {
      try {
        git(['worktree', 'prune']);
      } catch {
        // prune 失败不影响判定：残留条目由下一次 `git worktree list` 暴露。
      }
    });
  unlink(path);
  remove(path);
  prune();
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
        `FAIL: 干净检出里 linkModules 没成（${link.reason}），没有完成 CI 等价复跑——这不是绿。\n` +
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
