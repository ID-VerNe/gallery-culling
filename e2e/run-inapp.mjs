/**
 * 应用内驱动 e2e 编排器（真窗口 + 真 Rust 后端 + 真 LUMEN sidecar）。
 *
 * 为什么不用 Playwright：本机 WebView2 的 `--remote-debugging-port` **只服务
 * 第一个 HTTP 请求**，第二个请求（`/json/list`）就永久卡死 → `connectOverCDP`
 * 必然超时（详见 `.plan/lumen-preset-autotone-console-diagnosis-2026-10-15.md`）。
 * 旧编排器 `e2e/run.mjs` 仍在等 CDP 页面 target，因此在本机只会白等到超时。
 *
 * 因此改为：**应用内**执行场景（`src/devtools/e2eRunner.ts`）→ 每步日志同源
 * POST 到 Vite 的 `/__e2e_log` → 本脚本读 `e2e/.tmp/e2e-app.log` 断言 UI 部分，
 * 并直接读文件系统断言落盘与清单（浏览器里读不到目录，账实对账必须在这边做）。
 *
 * 用法：
 *   node e2e/run-inapp.mjs --scenario=render-export
 *   node e2e/run-inapp.mjs --scenario=lumen-preset
 *   node e2e/run-inapp.mjs --scenario=render-export --timeout=600000
 *
 * 退出码：全绿 0，断言失败 1，启动/超时 2。
 *
 * 注意：启动前会 `killApp()` 收掉本机正在跑的 gallery-culling（含手动开的），
 * 这是既有 e2e 行为 —— 1420 端口只允许一个实例，不允许两个并存。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  spawnDevTree,
  killApp,
  closeAppGracefully,
  waitForLog,
  PROJECT_ROOT,
} from './lib/app.mjs';
import { generateFixtures, JPG, RAW, OUT } from './fixtures/generate.mjs';

const LOG_FILE = path.join(PROJECT_ROOT, 'e2e', '.tmp', 'e2e-app.log');
const DEV_LOG = path.join(PROJECT_ROOT, 'e2e', '.tmp', 'tauri-dev.log');

const argv = process.argv.slice(2);
const arg = (k) => argv.find((a) => a.startsWith('--' + k + '='))?.split('=')[1];

const scenario = arg('scenario') || 'render-export';
const timeoutMs = Number(arg('timeout') || 20 * 60_000);

/** 极简断言收集器：每条 check 立即打印，最后汇总失败明细。 */
function createReporter() {
  const rows = [];
  return {
    check(name, ok, detail) {
      rows.push({ name, ok: !!ok, detail });
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' :: ' + detail : ''}`);
      return !!ok;
    },
    note(msg) {
      console.log('  ·  ' + msg);
    },
    summary() {
      const failures = rows.filter((r) => !r.ok);
      return { total: rows.length, failed: failures.length, failures };
    },
  };
}

/** 读文件尾部（诊断用；读不到返回空串而不是抛错）。 */
function tailOf(file, n = 2000) {
  try {
    return fs.readFileSync(file, 'utf8').slice(-n);
  } catch {
    return '';
  }
}

/**
 * 成片导出的落盘与清单对账。
 *
 * 断言的是**账实一致性**，不是「渲出来几张」：夹具里走 RAW 的那几张必然失败
 * （RAW 是 JPEG 改后缀），纯 JPG 那几张能否成功取决于引擎，写死就会变成脆断言。
 * 真正必须成立的是：清单说的和磁盘上的一致、失败项没有偷偷落地、没有半成品残留。
 */
function checkRenderOutput(log, R) {
  const files = fs.readdirSync(OUT);
  R.note('OUT: ' + (files.join(', ') || '(空)'));

  R.check(
    '无残留临时目录',
    !files.some((f) => f.includes('.gallery-export-tmp-')),
    files.join(','),
  );
  R.check('写入 .gallery-export.json', files.includes('.gallery-export.json'));

  const manifestPath = path.join(OUT, '.gallery-export.json');
  if (!fs.existsSync(manifestPath)) return;

  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  R.note('清单: ' + JSON.stringify(m).slice(0, 400));

  R.check('清单 mode=render', m.mode === 'render', String(m.mode));
  R.check('清单 render.format=jpg', m.render?.format === 'jpg', JSON.stringify(m.render));
  R.check(
    '清单未出现 longEdge（选的是「原始」）',
    !!m.render && !('longEdge' in m.render),
    JSON.stringify(m.render),
  );

  const items = m.items || [];
  const results = items.map((i) => i.result);
  R.check('清单非空', items.length > 0);
  // 渲染模式不得复用复制模式的词 —— 用户要能一眼看出这批是渲出来的
  R.check('渲染模式不复用 copied 一词', !results.includes('copied'), results.join(','));
  R.check(
    '逐项结果只在 rendered|failed 中',
    results.every((r) => r === 'rendered' || r === 'failed'),
    results.join(','),
  );

  const rendered = items.filter((i) => i.result === 'rendered');
  const failed = items.filter((i) => i.result === 'failed');
  const missing = rendered.filter((i) => !fs.existsSync(i.dst));
  const leaked = failed.filter((i) => fs.existsSync(i.dst));

  R.check(
    `rendered 项均已落地（${rendered.length}）`,
    missing.length === 0,
    missing.map((i) => i.dst).join(','),
  );
  R.check(
    `failed 项均未落地（${failed.length}）`,
    leaked.length === 0,
    leaked.map((i) => i.dst).join(','),
  );

  const expectStatus = failed.length ? 'failed' : 'completed';
  R.check(
    `清单 status 与失败数一致（期望 ${expectStatus}）`,
    m.status === expectStatus,
    String(m.status),
  );

  // 结果条读数 vs 清单：两处口径必须一致，否则用户看到的数与磁盘上的数对不上
  const reading = log.match(/读数 exported=(\d+) failed=(\d+)/);
  if (!reading) {
    R.check('解析到结果条读数', false, '日志里没有「读数 exported=…」行');
    return;
  }
  R.check(
    `结果条「已生成」数 = 清单 rendered 数（${reading[1]}）`,
    Number(reading[1]) === rendered.length,
    `日志=${reading[1]} 清单=${rendered.length}`,
  );
  R.check(
    `结果条「失败」数 = 清单 failed 数（${reading[2]}）`,
    Number(reading[2]) === failed.length,
    `日志=${reading[2]} 清单=${failed.length}`,
  );
}

async function main() {
  const t0 = Date.now();
  console.log(`=== 应用内 e2e：${scenario} ===`);

  console.log('--- 重建测试素材 ---');
  const fx = generateFixtures();
  console.log('素材：' + fx.root);

  // 先收上一轮（含 vite）再清空日志：否则旧 vite 会在清空后继续追加，
  // 上一轮的 `=== e2e done` 会让 waitForLog 立刻假命中。
  killApp();
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.writeFileSync(LOG_FILE, '', 'utf8');

  console.log('--- 启动应用（首次/改动 Rust 要编译，耐心等）---');
  await spawnDevTree({
    logFile: DEV_LOG,
    extraEnv: {
      VITE_E2E_SCENARIO: scenario,
      VITE_E2E_JPG: JPG,
      VITE_E2E_RAW: RAW,
      VITE_E2E_OUT: OUT,
      // 刻意**不传** WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS：
      //   1. 应用内驱动不需要 CDP（本机 CDP 也只服务第一个请求，连不上）；
      //   2. main.rs 只在变量**未设置**时才写 `--in-process-gpu`，这里一旦传了
      //      别的值就会把它抹掉 → GPU 子进程 9 连崩 → 白屏 +
      //      `msedgewebview2 has stopped working`（2026-10-17 实际踩到的回归）。
      // 需要加参数时请用 `webviewArgs()`，它会显式带上 `--in-process-gpu`。
    },
  });

  console.log('--- 等待场景跑完（e2e/.tmp/e2e-app.log）---');
  const hit = await waitForLog(LOG_FILE, (c) => /=== e2e done \(/.test(c), { timeoutMs });
  if (!hit) {
    console.error(`\n场景未在 ${Math.round(timeoutMs / 1000)}s 内结束。`);
    console.error('--- e2e-app.log 尾部 ---\n' + (tailOf(LOG_FILE, 1500) || '(空)'));
    console.error('--- tauri-dev.log 尾部 ---\n' + (tailOf(DEV_LOG) || '(空)'));
    await closeAppGracefully().catch(() => {});
    return 2;
  }
  console.log(`场景结束（${Math.round(hit.elapsedMs / 1000)}s）`);

  console.log('--- 关闭应用 ---');
  await closeAppGracefully().catch(() => {});

  const log = hit.content;
  const R = createReporter();

  // ── A. UI 层（读场景日志）─────────────────────────────────
  console.log('\n[A] 场景日志断言');
  R.check('应用挂载', /应用挂载 = true/.test(log));
  R.check('主界面就绪', /主界面就绪 = true/.test(log));
  R.check('扫描完成', /扫描完成（[^）]*）= true/.test(log));
  R.check('无 FATAL', !/FATAL:/.test(log), (log.match(/FATAL:[^\n]*/g) || []).join(' | '));

  // 场景里每条 `>>> 断言X … = true|false` 都必须为真
  const asserts = [...log.matchAll(/>>> (断言\S+)[^\n]*? = (true|false)/g)];
  const falseAsserts = asserts.filter((m) => m[2] === 'false');
  R.check(
    `场景内断言全部为真（共 ${asserts.length} 条）`,
    asserts.length > 0 && falseAsserts.length === 0,
    falseAsserts.map((m) => m[1].trim()).join(' | '),
  );

  // ── B. 落盘 / 清单（读文件系统）──────────────────────────
  if (scenario === 'render-export') {
    console.log('\n[B] 落盘与清单断言');
    checkRenderOutput(log, R);
  }

  const sum = R.summary();
  console.log('\n' + '='.repeat(56));
  console.log(
    `合计 ${sum.total - sum.failed}/${sum.total} 通过，用时 ${Math.round(
      (Date.now() - t0) / 1000,
    )}s`,
  );
  if (sum.failed) {
    console.log('失败明细：');
    for (const f of sum.failures) {
      console.log('  - ' + f.name + (f.detail ? ' :: ' + f.detail : ''));
    }
    return 1;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('\n编排异常：' + (err && err.stack ? err.stack : err));
    killApp();
    process.exit(2);
  });
