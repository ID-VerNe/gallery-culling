/**
 * LUMEN RAW 预设 + 自动调色 —— 滑杆真实生效（回归套件）。
 *
 * 这两个入口的失败模式都是「点了没反应」，单测测不到（需要真 sidecar）：
 *   1. 预设：后端 apply_preset 只改 sidecar 进程内 session 不落盘，
 *      随后的 getToneState 走 B 通道新进程读 .lumen → 读回旧值 → 滑杆不动；
 *   2. 自动：视口 <img> 无 crossOrigin，asset 协议跨源 → canvas 被污染 →
 *      getImageData 抛 SecurityError 被 catch 静默吞掉（返回全 0）→ 滑杆不动。
 *
 * 本套件连真窗口 + 真 sidecar，全链路验证：
 *   前置：设置 UI 幂等开启 LUMEN 引擎（dev 库默认关闭）；
 *   场景 A（预设）：IMG_010 干净照片 → 套用预设 → 断言
 *     a) 滑杆读回变化值（getToneState 回填生效）
 *     b) .lumen 工程落盘（apply+save 同进程）
 *   场景 B（自动）：IMG_011 → 点「自动」→ 断言
 *     a) 无 "Failed to compute auto tone" console 警告（canvas 未污染）
 *     b) 记录滑杆实际变化（采样成功的直接证据）
 *
 * 所有关键中间态（滑杆 before/after、.lumen 内容、console 消息、耗时）
 * 都打进 reporter 输出，便于失败时定位到底断在哪一环。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createReporter, scanAndWait, sleep, clearModals } from '../lib/harness.mjs';
import { JPG } from '../fixtures/generate.mjs';

export const name = '08-lumen-preset';

/** 读 6 条调色滑杆（排除 AI 蒙版的去薄雾滑杆）。 */
const readSliders = (page) =>
  page.$$eval('input[type="range"]', (els) =>
    els
      .map((e) => ({
        name: (e.getAttribute('aria-label') || '').split('，')[0],
        value: Number(e.value),
      }))
      .filter((s) => !/蒙版/.test(s.name)),
  );

const changed = (a, b) => JSON.stringify(a) !== JSON.stringify(b);

export async function run({ page }) {
  const R = createReporter(name);
  const t0 = Date.now();
  const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  // 收集与自动调色/画布安全相关的 console 消息（SecurityError 是静默失败的唯一痕迹）
  const consoleMsgs = [];
  page.on('console', (m) => {
    const t = m.text();
    if (/auto tone|SecurityError|tainted/i.test(t)) consoleMsgs.push(`[${m.type()}] ${t}`);
  });

  // ── 前置：开启 LUMEN 引擎（幂等） ─────────────────────────────
  R.section('前置：确保 LUMEN 引擎开启');
  await clearModals(page);
  await page.getByRole('button', { name: '设置' }).click();
  await sleep(1000);
  const dlg = page.locator('[role="dialog"][aria-modal="true"]');
  R.check('设置弹窗打开', (await dlg.count()) > 0);
  const toggle = dlg.locator('#settings-lumen-enabled');
  if (await toggle.count()) {
    const checked = await toggle.isChecked();
    R.note(`引擎开关当前 = ${checked ? '已开启' : '关闭'}`);
    if (!checked) {
      await toggle.check();
      await sleep(300);
      await dlg.getByRole('button', { name: /保存设置/ }).first().click();
      await sleep(1500);
      const closed = (await page.locator('[role="dialog"][aria-modal="true"]').count()) === 0;
      R.check('设置已保存（引擎开关打开）', closed);
    } else {
      await clearModals(page);
    }
  } else {
    R.check('找到 LUMEN 引擎开关', false, '未找到 #settings-lumen-enabled');
    await clearModals(page);
  }
  // 1500ms 重探延迟 + lumen-cli --version + 能力探测（命令表/预设/AI flavor）
  await sleep(3500);
  R.note(`引擎就绪等待完成（${el()}）`);

  // ── 扫描与进入调色面板 ───────────────────────────────────────
  R.section('扫描与进入调色面板');
  await scanAndWait(page, { jpgFolder: JPG, rawFolder: '' });
  await page.locator('[role="option"]', { hasText: 'IMG_010' }).first().click();
  await sleep(600);
  await page.keyboard.press('e');
  await sleep(900);
  R.check('调色面板已打开', (await page.getByRole('button', { name: /保存调色/ }).count()) > 0);

  // ── 场景 A：预设 ─────────────────────────────────────────────
  R.section('场景 A：LUMEN RAW 预设');
  const presetSelect = page.locator('#tonal-preset');
  let presetVisible = false;
  for (let i = 0; i < 20; i++) {
    if (await presetSelect.count()) {
      presetVisible = true;
      break;
    }
    await sleep(1500);
  }
  R.check('预设下拉出现（引擎握手 + caps 探测成功）', presetVisible, `等待 ${el()}`);
  if (!presetVisible) {
    const panelText = await page.locator('body').innerText();
    R.note('面板文本快照: ' + panelText.replace(/\s+/g, ' ').slice(0, 800));
    R.note('console 记录: ' + JSON.stringify(consoleMsgs));
    return R.summary();
  }
  const presetNames = await presetSelect.locator('option').allTextContents();
  R.note('预设清单: ' + presetNames.filter((n) => n.trim()).join(' / '));

  const before = await readSliders(page);
  R.note(`套用前滑杆: ${JSON.stringify(before)}`);

  const pickName = presetNames.find((n) => n && !/选择预设/.test(n));
  await presetSelect.selectOption({ label: pickName });
  await sleep(500);
  const confirmBtn = page.getByRole('button', { name: '套用并保存' });
  R.check('二次确认对话框出现', (await confirmBtn.count()) > 0);
  await confirmBtn.click();
  R.note(`已点击「套用并保存」（${pickName}），等待 apply+save+读回…`);

  // 等滑杆读回变化：apply（A 通道首启可能要 spawn+握手）→ save → getToneState → 回填
  let after = before;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    after = await readSliders(page);
    if (changed(before, after)) break;
  }
  R.note(`套用后滑杆: ${JSON.stringify(after)}（${el()}）`);
  R.check(
    '预设生效：滑杆读回变化值',
    changed(before, after),
    `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
  );

  const lumenFile = path.join(JPG, 'IMG_010.lumen');
  const hasLumen = fs.existsSync(lumenFile);
  R.check('.lumen 工程已落盘（apply+save 同进程）', hasLumen, lumenFile);
  if (hasLumen) {
    const raw = fs.readFileSync(lumenFile, 'utf8');
    R.note('.lumen 内容: ' + raw.replace(/\s+/g, ' ').slice(0, 600));
  }

  const panelText = await page.locator('body').innerText();
  R.check('出现「已应用预设」toast', /已应用预设/.test(panelText));
  R.note('场景 A console 记录: ' + JSON.stringify(consoleMsgs));

  // ── 场景 B：自动调色 ─────────────────────────────────────────
  R.section('场景 B：自动调色（canvas 采样）');
  await page.keyboard.press('Escape');
  await sleep(700);
  await page.locator('[role="option"]', { hasText: 'IMG_011' }).first().click();
  await sleep(600);
  await page.keyboard.press('e');
  await sleep(1500); // 等视口图加载完成（采样前提 complete && naturalWidth>0）

  const beforeAuto = await readSliders(page);
  R.note(`自动前滑杆: ${JSON.stringify(beforeAuto)}`);
  await page.getByRole('button', { name: '智能自动调色' }).click();
  await sleep(4000); // 采样 +（若主图被污染）带 CORS 副本回退重载
  const afterAuto = await readSliders(page);
  R.note(`自动后滑杆: ${JSON.stringify(afterAuto)}`);

  const autoWarns = consoleMsgs.filter((m) => /auto tone/i.test(m));
  R.check(
    '无「Failed to compute auto tone」警告（canvas 未被污染）',
    autoWarns.length === 0,
    autoWarns.join(' | ').slice(0, 300),
  );
  R.note(`自动调色滑杆变化 = ${changed(beforeAuto, afterAuto)}`);
  R.note(`场景 B console 记录: ${JSON.stringify(consoleMsgs)}`);

  return R.summary();
}
