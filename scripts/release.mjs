import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 发版前必须跑的真窗口 e2e；走 package.json 的脚本，别和本地手跑的口径分叉。 */
export const E2E_UI_CMD = 'npm run e2e:ui';
/** 唯一允许的跳过开关。除了它，没有任何绕过路径。 */
export const E2E_SKIP_ENV = 'SKIP_E2E';

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
        '修好后重跑 `npm run e2e:ui` 直到 6/6 通过。不要改断言换绿。',
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

export async function main({
  rootDir = path.join(__dirname, '..'),
  exec = execSync,
  env = process.env,
} = {}) {
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
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isMain) {
  main().catch((err) => {
    console.error('\n❌ 脚本执行失败:', err.message);
    process.exit(1);
  });
}
