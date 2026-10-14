import { createReporter, readCells, scanAndWait, sleep, clearModals } from '../lib/harness.mjs';
import { JPG, RAW, EXPECTED, PAIRED_STEMS, RAW_ONLY_STEM } from '../fixtures/generate.mjs';

export const name = '06-raw-settings';
const N_JPG = Object.keys(EXPECTED).length - 1; // 12

export async function run({ page, browser }) {
  const R = createReporter(name);
  await scanAndWait(page, { jpgFolder: JPG, rawFolder: RAW });

  const cells = await readCells(page);
  R.note(cells.join('\n'));
  R.section('配对');
  R.check(`扫描总数 = ${N_JPG + 1}（12 JPG + 1 RAW-only）`, cells.length === N_JPG + 1, `${cells.length} 张`);
  for (const stem of PAIRED_STEMS) {
    // 宫格按文件名排序，下标不等于 PAIRED_STEMS 的下标，必须按词干找
    const cell = cells.find((c) => c.includes(stem)) || '(未找到)';
    R.check(`${stem} 配对成 JPG+RAW`, /RAW/.test(cell), cell);
  }
  R.check('RAW-only 进入集合', cells.some((c) => c.includes(RAW_ONLY_STEM)), cells.find((c) => c.includes('RAW_ONLY')) || '未出现');

  R.section('回归：配 RAW 后 JPG 旁的 sidecar 仍要读到');
  for (const stem of PAIRED_STEMS) {
    const exp = EXPECTED[stem];
    const cell = cells.find((c) => c.includes(stem)) || '';
    const starOk = exp.rating === 0 ? /未打分/.test(cell) : new RegExp(`${exp.rating} 星`).test(cell);
    R.check(`${stem} 配 RAW 后仍读到 ${exp.rating}★`, starOk, cell);
  }

  R.section('RAW-only 占位（C2）');
  await page.locator('[role="option"]', { hasText: RAW_ONLY_STEM }).first().click();
  await sleep(3000);
  const body = await page.locator('body').innerText();
  R.check('显示 LUMEN 占位而非破图', /LUMEN RAW 引擎|需启用|无法预览/.test(body));
  const broken = await page.$$eval('img', (els) =>
    els.filter((i) => i.complete && i.naturalWidth === 0).map((i) => (i.getAttribute('src') || '').slice(0, 40)));
  R.check('视口无破图（naturalWidth=0）', broken.length === 0, broken.join('|'));

  R.section('设置持久化');
  await page.getByRole('button', { name: '设置' }).click();
  await sleep(900);
  const dlg = page.locator('[role="dialog"][aria-modal="true"]');
  R.check('设置弹窗打开', (await dlg.count()) > 0);
  const txt = await dlg.innerText();
  R.check('含 LUMEN 引擎开关', /LUMEN/i.test(txt));
  R.check('含缩略图宽度设置', /缩略图/.test(txt));
  const tw = dlg.locator('input[type="number"]').first();
  if (await tw.count()) {
    await tw.fill('256');
    await sleep(300);
    R.check('缩略图宽度可改为 256', (await tw.inputValue()) === '256');
    await dlg.getByRole('button', { name: /保存设置|保存/ }).first().click();
    await sleep(1500);
    await clearModals(page);
    R.check('保存后弹窗关闭', (await page.locator('[role="dialog"][aria-modal="true"]').count()) === 0);
    await page.getByRole('button', { name: '设置' }).click();
    await sleep(1200);
    const tw2 = page.locator('[role="dialog"][aria-modal="true"]').locator('input[type="number"]').first();
    if (await tw2.count()) R.check('缩略图宽度 256 已持久化', (await tw2.inputValue()) === '256', await tw2.inputValue());
    await clearModals(page);
  } else R.note('未找到缩略图宽度输入');

  return R.summary();
}
