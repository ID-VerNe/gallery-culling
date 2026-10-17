/**
 * 真窗口 E2E 编排器（**Playwright / CDP 路线**）。
 *
 * ⚠️ 本机跑不通：WebView2 的 `--remote-debugging-port` 只服务第一个 HTTP
 * 请求，`launchApp` 里等页面 target 的 `appPageReady()` 永远为假，最终白等到
 * 超时（详见 `.plan/lumen-preset-autotone-console-diagnosis-2026-10-15.md`）。
 * 真窗口用例请用应用内驱动：`npm run e2e:render` / `npm run e2e:preset`
 * （见 `e2e/run-inapp.mjs` 与 `src/devtools/e2eRunner.ts`）。
 * 保留本文件只为在 CDP 正常的机器上仍可用。
 *
 * 流程：重建素材 -> 启动应用(带 CDP) -> 逐个套件 -> 关应用 -> 汇总。
 * 退出码：全绿 0，有失败 1，启动失败 2。
 *
 * 用法：
 *   npm run e2e:app                   # 全跑
 *   npm run e2e:app -- --only=02,05   # 只跑指定套件
 *   npm run e2e:app -- --attach        # 附着到已在跑的实例
 *   npm run e2e:app -- --skip-session  # 跳过要重启应用的那套
 */
import { launchApp, closeAppGracefully, cdpReady } from './lib/app.mjs';
import { connect, clearModals } from './lib/harness.mjs';
import { generateFixtures } from './fixtures/generate.mjs';

import * as s01 from './suites/01-scan.mjs';
import * as s02 from './suites/02-rating.mjs';
import * as s03 from './suites/03-nav.mjs';
import * as s04 from './suites/04-tone.mjs';
import * as s05 from './suites/05-export.mjs';
import * as s06 from './suites/06-raw-settings.mjs';
import * as s07 from './suites/07-session.mjs';
import * as s08 from './suites/08-lumen-preset.mjs';

const SUITES = [s01, s02, s03, s04, s05, s06, s07, s08];
const argv = process.argv.slice(2);
const arg = (k) => argv.find((a) => a.startsWith('--' + k + '='))?.split('=')[1];
const has = (k) => argv.includes('--' + k);

const only = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean);
const attach = has('attach');

let selected = SUITES;
if (only) {
  selected = SUITES.filter((s) => only.some((o) => s.name.includes(o)));
  if (!selected.length) {
    console.error('没有匹配 --only=' + only.join(',') + ' 的套件。可用：' + SUITES.map((s) => s.name).join(', '));
    process.exit(2);
  }
}
const skipSession = has('skip-session') || (!!only && !only.some((o) => o.includes('07')));
if (skipSession) selected = selected.filter((s) => s !== s07);

console.log('=== 真窗口 E2E ===');
console.log('套件：' + selected.map((s) => s.name).join(', '));
console.log('');

const t0 = Date.now();
const summaries = [];
let owned = false;

try {
  console.log('--- 重建测试素材 ---');
  const fx = generateFixtures();
  console.log('素材：' + fx.root);

  if (attach) {
    if (!(await cdpReady())) {
      throw new Error('--attach 但 CDP 不可用，请先手动起 npm run tauri dev');
    }
    console.log('附着到已在运行的实例');
  } else {
    console.log('--- 启动应用（首次可能要编译，耐心等）---');
    const app = await launchApp();
    owned = true;
    console.log('应用就绪（' + Math.round(app.bootMs / 1000) + 's）');
  }

  for (const suite of selected) {
    console.log('\n' + '='.repeat(56));
    console.log('套件 ' + suite.name);
    console.log('='.repeat(56));
    const { page, browser } = await connect();
    await clearModals(page);
    try {
      const summary = await suite.run({ page, browser });
      summaries.push({ name: suite.name, ...summary });
    } catch (err) {
      console.error('  ERROR  ' + (err && err.message));
      summaries.push({
        name: suite.name, total: 1, failed: 1,
        failures: [{ name: '套件异常', detail: String(err && err.message) }],
      });
      try { await browser.close(); } catch { /* noop */ }
    }
  }
} catch (err) {
  console.error('\n启动/编排失败：' + (err && err.message));
  if (owned) await closeAppGracefully().catch(() => {});
  process.exit(2);
}

if (owned) {
  console.log('\n--- 关闭应用 ---');
  await closeAppGracefully().catch(() => {});
}

console.log('\n' + '='.repeat(56));
console.log('汇总');
console.log('='.repeat(56));
let tot = 0;
let bad = 0;
for (const s of summaries) {
  console.log('  ' + s.name.padEnd(14) + ' ' + (s.total - s.failed) + '/' + s.total + (s.failed ? '  <-- ' + s.failed + ' 失败' : ''));
  tot += s.total;
  bad += s.failed;
}
console.log('\n合计 ' + (tot - bad) + '/' + tot + ' 通过，用时 ' + Math.round((Date.now() - t0) / 1000) + 's');
if (bad) {
  console.log('\n失败明细：');
  for (const s of summaries) for (const f of s.failures || []) console.log('  - [' + s.name + '] ' + f.name + (f.detail ? ' :: ' + f.detail : ''));
  process.exit(1);
}
process.exit(0);
