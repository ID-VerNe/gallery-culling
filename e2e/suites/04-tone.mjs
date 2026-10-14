import path from 'node:path';
import fs from 'node:fs';
import { createReporter, readXmpTag, waitForXmp, scanAndWait, sleep } from '../lib/harness.mjs';
import { JPG } from '../fixtures/generate.mjs';

export const name = '04-tone';

const xp = (s) => path.join(JPG, `${s}.xmp`);
const TONE_TAGS = ['crs:Exposure2012','crs:Highlights2012','crs:Shadows2012','crs:Temperature2012','crs:Contrast2012'];

export async function run({ page, browser }) {
  const R = createReporter(name);
  await scanAndWait(page, { jpgFolder: JPG, rawFolder: '' });
  await page.locator('[role="option"]', { hasText: 'IMG_004' }).first().click();
  await sleep(600);
  await page.keyboard.press('e');
  await sleep(700);
  const save = page.getByRole('button', { name: /保存调色/ });
  R.check('按 E 打开调色面板', (await save.count()) > 0 && (await save.first().isVisible()));
  R.check('面板打开时宫格被取代', (await page.locator('text=宫格列表').count()) === 0);

  R.section('滑杆');
  const sliders = await page.$$eval('input[type="range"]', (els) =>
    els.map((e) => ({ name: e.getAttribute('aria-label') || '', value: e.value })));
  R.check(`调色面板含 6 条滑杆（实际 ${sliders.length}）`, sliders.length === 6);

  R.section('读回 XMP 预置 tone');
  for (const t of TONE_TAGS) R.note(`${t} = ${readXmpTag(xp('IMG_004'), t)}`);
  R.check('曝光读到预置 +0.65', readXmpTag(xp('IMG_004'), 'crs:Exposure2012') === '+0.65', readXmpTag(xp('IMG_004'), 'crs:Exposure2012'));
  R.check('对比度读到预置 +10', readXmpTag(xp('IMG_004'), 'crs:Contrast2012') === '+10', readXmpTag(xp('IMG_004'), 'crs:Contrast2012'));
  const exp = sliders.find((s) => /曝光/.test(s.name));
  if (exp) R.check('曝光滑杆反映 XMP (+0.65)', Math.abs(Number(exp.value) - 0.65) < 0.02, `value=${exp.value}`);

  R.section('改动并保存');
  await page.evaluate(() => {
    const s = [...document.querySelectorAll('input[type="range"]')]
      .find((e) => /曝光/.test(e.getAttribute('aria-label') || ''));
    if (!s) return;
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(s, '1.20');
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(500);
  R.check('改动后保存按钮可用', await save.first().isEnabled());
  await save.first().click();
  await sleep(1500);

  for (const t of TONE_TAGS) R.note(`${t} = ${readXmpTag(xp('IMG_004'), t)}`);
  R.check('曝光写入 XMP 为 +1.20', readXmpTag(xp('IMG_004'), 'crs:Exposure2012') === '+1.20', readXmpTag(xp('IMG_004'), 'crs:Exposure2012'));
  R.check('其它 tone 标签未被破坏（保存是非破坏性的）', readXmpTag(xp('IMG_004'), 'crs:Contrast2012') === '+10', readXmpTag(xp('IMG_004'), 'crs:Contrast2012'));
  R.check('星级未被调色保存影响', readXmpTag(xp('IMG_004'), 'xmp:Rating') === '4', readXmpTag(xp('IMG_004'), 'xmp:Rating'));

  R.section('关闭面板');
  await page.keyboard.press('Escape');
  await sleep(700);
  R.check('Esc 关闭调色面板并归还宫格', (await page.getByRole('button', { name: /保存调色/ }).count()) === 0);

  return R.summary();
}
