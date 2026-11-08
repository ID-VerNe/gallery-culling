import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 发版前必须跑的真窗口 e2e；走 package.json 的脚本，别和本地手跑的口径分叉。 */
export const E2E_UI_CMD = 'npm run e2e:ui';
/** 唯一允许的跳过开关。除了它，没有任何绕过路径。 */
export const E2E_SKIP_ENV = 'SKIP_E2E';
/** `--publish`：在构建之后接续「提交 / tag / Release / 资产 / 复核」全链（issue #83）。 */
export const PUBLISH_FLAG = '--publish';

/**
 * 发版前的 e2e 闸门判定（纯函数，便于单测与变异）。
 *
 * 为什么发版要强制跑真窗口 e2e：底栏按钮命中（#46）、静息态底板收起（#47）、
 * 左手别名与 e.code 等价（#45）这三类回归**只有真窗口能暴露**——jsdom 的
 * getByRole + click 全绿也照样坏。issue #57 的问题不是「没人知道要跑」，而是
 * 「只在 PR 描述里提一句，没有任何强制点，过两周就没人跑」。所以判定必须落在
 * 脚本里，不能落在人的记性里。
 *
 * 退出码口径来自 `e2e/run-inapp.mjs:18`：0 全绿 / 1 断言失败 / 2 启动或超时。
 * 1 与 2 的下一步排查方向完全不同，文案必须分开写——只说「失败了」等于把
 * 排查工作整块推回给发版的人。
 */
export function evaluateE2eUiGate({ exitCode = 0 } = {}) {
  if (exitCode === 0) {
    return { ok: true, kind: 'pass', message: '✅ 真窗口 e2e 通过。' };
  }
  if (exitCode === 1) {
    return {
      ok: false,
      kind: 'regression',
      message: [
        '❌ e2e:ui 断言失败（真回归）：ui-contract 里有 UI 断言为 false。',
        '下一步：往上翻 FAIL 行，按断言号定位——底栏命中是 U8，静息收起是 U1/U2b，左手别名是 U13/U14；',
        '修好后重跑 `npm run e2e:ui` 直到全部通过（PASS 数 = 总数）。不要改断言换绿。',
      ].join('\n'),
    };
  }
  if (exitCode === 2) {
    return {
      ok: false,
      kind: 'environment',
      message: [
        '❌ e2e:ui 启动失败或超时（环境问题，不是回归）：应用没起来，或场景没在时限内跑完。',
        '下一步：确认没有别的 gallery-culling 实例占着 1420 端口、WebView2 没崩（`msedgewebview2 has stopped working`），',
        '再看 `e2e/.tmp/tauri-dev.log` 与 `e2e/.tmp/e2e-app.log` 的尾部；然后手动重跑一次 `npm run e2e:ui`。',
      ].join('\n'),
    };
  }
  return {
    ok: false,
    kind: 'unknown',
    message: `❌ e2e:ui 以未知退出码 ${exitCode} 结束（预期只有 0/1/2）。按失败处理：先手动跑 \`npm run e2e:ui\` 定位。`,
  };
}

/**
 * 「是否允许发版」的唯一断言入口：非 ok 直接 throw，调用方不需要再判断。
 */
export function assertE2eUiPassed({ exitCode = 0 } = {}) {
  const verdict = evaluateE2eUiGate({ exitCode });
  if (!verdict.ok) throw new Error(verdict.message);
  return verdict;
}

/**
 * 执行（或显式跳过）发版前的 e2e 闸门。
 *
 * 跳过只认 `SKIP_E2E=1`，且必须留下醒目痕迹：静默跳过 = 这个闸门等于没装。
 */
export function runE2eUiGate({ exec = execSync, rootDir, env = process.env } = {}) {
  const skipped = String(env[E2E_SKIP_ENV] || '').trim() === '1';
  if (skipped) {
    console.warn(
      '⚠️ SKIP_E2E=1：本轮发版跳过了真窗口 e2e（ui-contract 未跑）。' +
        '跳过原因必须写进 Release notes，并在此留痕——闸门不会静默放行。',
    );
    return { ok: true, skipped: true, exitCode: null, kind: 'skipped' };
  }

  console.log(`🧪 发版前强制运行真窗口 e2e（${E2E_UI_CMD}）…`);
  let exitCode = 0;
  try {
    exec(E2E_UI_CMD, { stdio: 'inherit', cwd: rootDir, env });
  } catch (err) {
    // execSync 在非 0 退出时抛错，退出码在 err.status；拿不到就按「环境类」保守处理。
    exitCode = typeof err.status === 'number' ? err.status : 2;
  }
  const verdict = assertE2eUiPassed({ exitCode });
  console.log(verdict.message);
  return verdict;
}

/**
 * 参数解析（issue #83）：只有 `--publish` 打开全链，其余参数一律忽略。
 *
 * 默认路径必须逐字保持「只构建」的旧行为——历史用法是 `RELEASE_NOTES=... node scripts/release.mjs`，
 * 少一个参数就悄悄开始 push / 建 Release 是不可接受的副作用。
 */
export function parseArgs(argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  return { publish: args.includes(PUBLISH_FLAG) };
}

/** 统一 digest 形状：去掉 `sha256:` 前缀、转小写，供应远端与本地直接比对。 */
function normalizeDigest(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, '');
}

/** 本地资产的 sha256，形状与 GitHub API 的 `digest` 字段一致（`sha256:<hex>`）。 */
export function sha256File(filePath) {
  const hex = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  return `sha256:${hex}`;
}

/**
 * 校验 `updater.json` 的 version 与 `tauri.conf.json` 一致。
 *
 * 为什么要拦：`updater.json` 是 tracked 文件，一次失败的发版可能留下上一版的残页；
 * 直接提交进新 Release 会让老客户端把「旧清单 + 新资产」当成有效更新（下载 404）。
 */
export function decideUpdaterVersion({ confVersion, updaterVersion }) {
  const expected = `v${confVersion}`;
  if (updaterVersion !== expected) {
    throw new Error(
      `❌ updater.json 的 version 是 ${updaterVersion || '（缺失）'}，与 tauri.conf.json 的 ` +
        `${confVersion} 不一致：拒绝把它提交进 Release。\n` +
        '下一步：确认本次 bump 两处版本号都改了（`package.json` / `src-tauri/tauri.conf.json`），再重跑发版。',
    );
  }
  return expected;
}

/**
 * tag 决策：已发出的 tag 指向别的提交时**只中止、不挪 tag**。
 * 重写已发布的 tag 会让已经下载过旧资产的用户拿到另一份文件，且远端 reflog 无法解释。
 */
export function decideTag({ existingTagSha, updaterSha }) {
  if (!existingTagSha) return { action: 'create' };
  if (existingTagSha === updaterSha) return { action: 'exists' };
  throw new Error(
    `❌ tag 已存在，但指向 ${String(existingTagSha).slice(0, 7)}，本次 updater.json 提交是 ` +
      `${String(updaterSha).slice(0, 7)}：不挪 tag。\n` +
      '下一步：确认这个 tag 是否属于别的版本；本次请换一个新版本号，或人工删除远端 tag 后重跑（脚本不替你删）。',
  );
}

/**
 * 资产决策：同名资产按 digest 判定。
 *
 * GitHub 不允许同名资产覆盖，所以「已存在但 digest 不同」只能是「同名文件被重新构建」——
 * 这必须中止并让人工删远端资产，静默跳过会把一份来历不明的 exe 留在 Release 上。
 */
export function decideAssetUpload({ existingAssets = [], assetName, localDigest }) {
  const hit = (existingAssets || []).find((item) => item && item.name === assetName);
  if (!hit) return { action: 'upload' };
  // digest 未回填：同名资产已存在、GitHub 还没算完 sha256。此时既不能覆盖（同名上传必 422），
  // 也无法证明是同一份文件——跳过上传，把判定交给末尾的 digest 复核（那边会要求稍候重跑）。
  if (!hit.digest) return { action: 'skip', unverified: true };
  if (normalizeDigest(hit.digest) === normalizeDigest(localDigest)) return { action: 'skip' };
  throw new Error(
    `❌ Release 上已有同名资产 ${assetName}，但 digest 不一致（远端 ${hit.digest || '（无 digest）'}，` +
      `本地 ${localDigest}）：同名资产不能覆盖。\n` +
      '下一步：在 GitHub 上删掉该资产后重跑（重跑会按 digest 跳过已完成的步骤）。',
  );
}

/** `releases/latest` 必须指向本次版本；否则「用户能下载，但更新弹窗永远不出现」。 */
export function evaluateLatest({ latestTag, tag }) {
  if (latestTag === tag) return { ok: true, match: true, message: `✅ releases/latest 已指向 ${tag}。` };
  return {
    ok: false,
    match: false,
    message:
      `❌ releases/latest 指向 ${latestTag || '（不可得）'}，不是 ${tag}。\n` +
      '下一步：Release 可能仍是 draft（`gh api repos/{owner}/{repo}/releases -q ".[] | .tag_name, .draft"`），' +
      '或存在语义上更高的已发布版本；确认后重跑即可（已完成步骤会跳过）。',
  };
}

/**
 * 结构化终态：一段可直接 grep / 机器解析的 `key=value`。
 *
 * 失败的判定权在调用方：`facts.status === 'FAILED'` 是显式失败，不能被派生出的
 * match 值翻绿——否则「构建成功但发布失败」又会退回成 exit 0。
 */
export function summarizePublish(facts = {}) {
  const digestMatch = normalizeDigest(facts.localDigest) === normalizeDigest(facts.remoteDigest);
  const latestMatch = facts.latestTag === facts.tag;
  const failed = facts.status === 'FAILED' || !digestMatch || !latestMatch;
  const shortSha = String(facts.commitSha || '').slice(0, 7);
  return [
    '=== 发布终态 ===',
    `version=v${String(facts.version || '').replace(/^v/, '')}`,
    `tag=${facts.tag} -> ${shortSha || '（未知）'}`,
    `release=${facts.releaseUrl || '（未创建）'}`,
    `asset=${facts.assetName || '（未上传）'} size=${facts.assetSize ?? '（未知）'}`,
    `digest=sha256:${normalizeDigest(facts.localDigest) || '（无）'} match=${digestMatch ? 'yes' : 'no'}`,
    `latest=${facts.latestTag || '（无）'} match=${latestMatch ? 'yes' : 'no'}`,
    `status=${failed ? 'FAILED' : 'PUBLISHED'}`,
  ].join('\n');
}

/**
 * `--publish` 全链（issue #83）：把 AGENTS.md §5 的第 4-7 步从「手工命令行」变成脚本动作。
 *
 * 设计口径：
 * - **幂等**：每一步先探测再动作。重跑时已提交的清单跳过提交、已指向本提交的 tag 跳过打 tag、
 *   已上传且 digest 一致的资产跳过上传；`latest` 与 digest 每次都要复核。
 * - **顺序**：建 Release 走 **REST** 并先置 draft，资产传完再 `draft=false`——
 *   规避本项目历史上 `gh release create` 的 GraphQL EOF，也避免「Release 已可见但没资产」的空窗。
 * - **失败**：打印 `status=FAILED stage=<步骤>` 后抛错，由 main 转 exit 1；不做任何远端回滚。
 */
export function publishRelease({
  rootDir = path.join(__dirname, '..'),
  exec = execSync,
  version,
  productName = 'gallery-culling',
  notes,
} = {}) {
  const tag = `v${version}`;
  const facts = {
    version,
    tag,
    commitSha: null,
    releaseUrl: null,
    assetName: null,
    assetSize: null,
    localDigest: null,
    remoteDigest: null,
    latestTag: null,
    status: null,
  };
  let stage = 'manifest';
  const run = (cmd) => String(exec(cmd, { cwd: rootDir, encoding: 'utf8' }) ?? '').trim();
  const runJson = (cmd) => {
    const out = run(cmd);
    try {
      return JSON.parse(out);
    } catch {
      throw new Error(`❌ 无法解析 \`${cmd}\` 的 JSON 输出：${out.slice(0, 200)}`);
    }
  };

  try {
    // 1. 清单版本自检：宁可中止，也不把旧 updater.json 提交进新 Release。
    const updater = JSON.parse(fs.readFileSync(path.join(rootDir, 'updater.json'), 'utf8'));
    decideUpdaterVersion({ confVersion: version, updaterVersion: updater.version });

    // 2. 提交 updater.json 并 push：老客户端读 master 的 raw 地址，推上去才触发更新弹窗。
    stage = 'commit';
    if (run('git status --porcelain updater.json')) {
      run('git add updater.json');
      run(`git commit -m "chore(release): update updater.json for ${tag}"`);
      console.log('📝 已提交 updater.json。');
    } else {
      console.log('ℹ️ updater.json 无变更，跳过提交。');
    }
    run('git push origin master');
    facts.commitSha = run('git rev-parse HEAD');

    // 3. annotated tag 指向本次提交；已存在则必须指向同一提交。
    stage = 'tag';
    const existingTagSha = run(`git tag --list ${tag}`) ? run(`git rev-list -n1 ${tag}`) : null;
    const tagDecision = decideTag({ existingTagSha, updaterSha: facts.commitSha });
    if (tagDecision.action === 'create') {
      run(`git tag -a ${tag} -m "${tag}" ${facts.commitSha}`);
      run(`git push origin ${tag}`);
      console.log(`🏷️ 已创建并推送 annotated tag ${tag}。`);
    } else {
      console.log(`ℹ️ tag ${tag} 已存在且指向本次提交，跳过。`);
    }

    // 4. Release：先 REST 建 draft，资产传完再发布。
    stage = 'release';
    const repo = run('gh repo view --json nameWithOwner --jq .nameWithOwner');
    let release = null;
    try {
      release = runJson(`gh api repos/${repo}/releases/tags/${tag}`);
    } catch (err) {
      // 404 = 本版本还没有 Release；其它错误（鉴权、网络）必须原样抛出去。
      if (!/404|not found/i.test(err.message)) throw err;
    }

    let releaseId;
    let releaseAssets = [];
    let releaseDraft = true;
    if (release) {
      releaseId = release.id;
      releaseDraft = Boolean(release.draft);
      releaseAssets = Array.isArray(release.assets)
        ? release.assets
        : runJson(`gh api repos/${repo}/releases/${releaseId}/assets`);
      facts.releaseUrl = release.html_url || null;
      console.log(`ℹ️ Release ${tag} 已存在（id=${releaseId}），复用。`);
    } else {
      const releaseNotes = (notes || '').trim() || updater.notes || tag;
      const notesPath = path.join(os.tmpdir(), `gallery-culling-release-notes-${version}-${process.pid}.md`);
      fs.writeFileSync(notesPath, releaseNotes, 'utf8');
      let created;
      try {
        created = runJson(
          `gh api -X POST repos/${repo}/releases -f tag_name=${tag} -f name=${tag} ` +
            `-F "body=@${notesPath}" -F draft=true -F prerelease=false`,
        );
      } finally {
        fs.rmSync(notesPath, { force: true });
      }
      releaseId = created.id;
      releaseAssets = Array.isArray(created.assets) ? created.assets : [];
      facts.releaseUrl = created.html_url || null;
      console.log(`📦 已通过 REST 创建 draft Release ${tag}（id=${releaseId}）。`);
    }

    // 5. 资产：只传 NSIS setup.exe（MSI 不传，AGENTS.md §5）。
    stage = 'asset';
    const setupExe = path.join(
      rootDir,
      'src-tauri',
      'target',
      'release',
      'bundle',
      'nsis',
      `${productName}_${version}_x64-setup.exe`,
    );
    if (!fs.existsSync(setupExe)) throw new Error(`❌ 找不到安装包：${setupExe}`);
    facts.assetName = path.basename(setupExe);
    facts.assetSize = fs.statSync(setupExe).size;
    facts.localDigest = sha256File(setupExe);
    const assetDecision = decideAssetUpload({
      existingAssets: releaseAssets,
      assetName: facts.assetName,
      localDigest: facts.localDigest,
    });
    if (assetDecision.action === 'upload') {
      run(`gh release upload ${tag} "${setupExe}"`);
      console.log(`⬆️ 已上传 ${facts.assetName}（${facts.assetSize} 字节）。`);
    } else if (assetDecision.unverified) {
      console.log('ℹ️ Release 上已有同名资产但 digest 尚未回填，跳过上传，判定交给末尾复核。');
    } else {
      console.log('ℹ️ Release 上已有同名资产且 digest 一致，跳过上传。');
    }

    // 6. 发布：draft → false，`releases/latest` 才会指向本版本。
    stage = 'publish';
    if (releaseDraft) {
      run(`gh api -X PATCH repos/${repo}/releases/${releaseId} -F draft=false`);
      console.log(`🚀 已将 Release ${tag} 置为已发布。`);
    }

    // 7. 复核：digest 与 latest 都是「用户真的能装到这个版本」的必要条件。
    stage = 'verify';
    const finalRelease = runJson(`gh api repos/${repo}/releases/tags/${tag}`);
    facts.releaseUrl = finalRelease.html_url || facts.releaseUrl;
    const remoteAsset = (finalRelease.assets || []).find((item) => item.name === facts.assetName);
    facts.remoteDigest = remoteAsset ? remoteAsset.digest ?? null : null;
    facts.latestTag = run(`gh api repos/${repo}/releases/latest --jq .tag_name`);

    const latest = evaluateLatest({ latestTag: facts.latestTag, tag });
    if (!latest.ok) throw new Error(latest.message);
    if (normalizeDigest(facts.remoteDigest) !== normalizeDigest(facts.localDigest)) {
      throw new Error(
        `❌ 远端资产 digest 与本地不一致（远端 ${facts.remoteDigest || '（GitHub 尚未回填 digest）'}，` +
          `本地 ${facts.localDigest}）：不能确认用户装到的是同一份安装包。\n` +
          '下一步：稍等片刻重跑（已上传资产会按 digest 跳过）；仍不一致说明上传的是另一份文件。',
      );
    }

    facts.status = 'PUBLISHED';
    console.log(`\n${summarizePublish(facts)}`);
    return facts;
  } catch (err) {
    facts.status = 'FAILED';
    console.log(`\n${summarizePublish(facts)}\nstage=${stage}`);
    throw err;
  }
}

export async function main({
  rootDir = path.join(__dirname, '..'),
  exec = execSync,
  env = process.env,
  argv = [],
} = {}) {
  const { publish } = parseArgs(argv);
  console.log('🚀 开始自动构建与发版流程...\n');

  // 1. 获取当前版本号
  const tauriConfPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');
  const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
  const version = tauriConf.version;
  const productName = tauriConf.productName || 'gallery-culling';
  console.log(`📦 当前打包版本: v${version}`);

  // 2. e2e 闸门：必须在签名构建之前。失败即 throw，updater.json 不落盘、也不打包。
  const e2eGate = runE2eUiGate({ exec, rootDir, env });

  // 3. 检查密钥文件
  const keyPath = path.join(rootDir, 'updater.key');
  if (!fs.existsSync(keyPath)) {
    console.warn('⚠️ 警告: 未找到 updater.key 密钥文件！必须存在私钥才能为更新包签名。');
  }

  // 4. 执行 Tauri 构建 (带签名)
  console.log('🔨 正在执行 Tauri Build 构建应用，这可能需要几分钟...');
  // 通过环境变量传入私钥内容
  const privateKey = fs.existsSync(keyPath) ? fs.readFileSync(keyPath, 'utf8') : '';
  // 用 npm 而不是 pnpm：项目已从 pnpm 迁到 npm（仓库里没有 pnpm-lock.yaml），
  // 用 pnpm 会按它自己的解析规则重装一遍依赖，与 node_modules 现状分叉。
  exec('npm run tauri build', {
    stdio: 'inherit',
    cwd: rootDir,
    env: {
      ...env,
      TAURI_SIGNING_PRIVATE_KEY: privateKey,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
    },
  });

  // 5. 寻找更新包和签名文件 (Tauri v2 Windows 默认提供 exe 和 msi，以及对应的 .sig 文件)
  // 优先寻找 NSIS 格式
  const nsisDir = path.join(rootDir, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
  const setupExeName = `${productName}_${version}_x64-setup.exe`;
  const sigName = `${setupExeName}.sig`;

  const sigPath = path.join(nsisDir, sigName);

  if (!fs.existsSync(sigPath)) {
    throw new Error(`❌ 签名文件未找到: ${sigPath}\n请确认构建时 Tauri 是否成功读取了私钥并生成了签名。`);
  }

  const signature = fs.readFileSync(sigPath, 'utf8').trim();
  console.log('🔑 成功提取更新包数字签名。');

  // 6. 生成 updater.json
  // 更新提示文案：默认简短一句；发布时可传 RELEASE_NOTES 覆盖，
  // 例如 RELEASE_NOTES="$(cat release-notes.md)" node scripts/release.mjs
  const notes = (env.RELEASE_NOTES || '').trim() || '🚀 应用有新版本发布啦！';
  const updaterObj = {
    version: `v${version}`,
    notes,
    pub_date: new Date().toISOString(),
    platforms: {
      'windows-x86_64': {
        signature,
        url: `https://github.com/ID-VerNe/gallery-culling/releases/download/v${version}/${setupExeName}`,
      },
    },
  };

  const updaterPath = path.join(rootDir, 'updater.json');
  fs.writeFileSync(updaterPath, JSON.stringify(updaterObj, null, 2));
  console.log(`\n✅ 成功生成 Tauri 更新配置: updater.json\n`);

  // 7. --publish：把 AGENTS.md §5 的第 4-7 步一次跑完（issue #83）。
  //    不带 --publish 时保持历史上的「只构建」行为，收尾仍打印手工步骤。
  if (publish) {
    const facts = publishRelease({ rootDir, exec, version, productName, notes });
    if (e2eGate.skipped) {
      console.warn(
        '⚠️ 发布汇总：真窗口 e2e 被 SKIP_E2E=1 显式跳过，本轮没有 ui-contract 保护。' +
          '这一步必须出现在 Release notes 里，否则等于没留痕。',
      );
    }
    console.log(`\n🎉 发布完成：${facts.releaseUrl}`);
    return facts;
  }

  console.log(`=========================================`);
  console.log(`🎉 打包与签名成功！接下来的发布步骤：`);
  console.log(`1. 在 GitHub 上创建一个 Release，标签为 v${version}`);
  console.log(`2. 将以下文件上传到该 Release 的附件中：\n   - ${path.join(nsisDir, setupExeName)}`);
  console.log(`3. 将本地新生成的 updater.json 执行 git commit 并 push 到 master 分支。`);
  if (e2eGate.skipped) {
    console.warn(
      '⚠️ 发布汇总：真窗口 e2e 被 SKIP_E2E=1 显式跳过，本轮没有 ui-contract 保护。' +
        '这一步必须出现在 Release notes 里，否则等于没留痕。',
    );
  } else {
    console.log('4. 真窗口 e2e（ui-contract）已在打包前通过，无需重复。');
  }
  console.log(`老客户端检测到 updater.json 发生变动后，就会自动弹窗提示用户更新了！`);
  console.log(`=========================================`);
  console.log(`💡 想省掉上面这些手工步骤：下次用 \`node scripts/release.mjs ${PUBLISH_FLAG}\` 一条命令跑完全链。`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isMain) {
  main({ argv: process.argv.slice(2) }).catch((err) => {
    console.error('\n❌ 脚本执行失败:', err.message);
    process.exit(1);
  });
}
