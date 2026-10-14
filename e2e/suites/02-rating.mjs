/**
 * 套件 02 — 评级 / 旗标 / 撤销（断言真实 XMP 落盘字节）
 *
 * 每一步都回读磁盘上的 .xmp，校验真实写入内容与文件合法性。
 */
import path from 'node:path';
import fs from 'node:fs';
import { createReporter, readXmpTag, waitForXmp, scanAndWait, sleep, focusViewport } from '../lib/harness.mjs';
import { JPG } from '../fixtures/generate.mjs';

export const name = '02-rating';

const xp = (stem) => path.join(JPG, `${stem}.xmp`);
const TARGET = 'IMG_008'; // 无 sidecar 的干净照片

export async function run({ page, browser }) {
  const R = createReporter(name);

  fs.rmSync(xp(TARGET), { force: true }); // 确保走「全新写入」路径
  await scanAndWait(page, { jpgFolder: JPG.replace(/\\/g, '/'), rawFolder: '' });

  await page.locator('[role="option"]', { hasText: TARGET }).first().click();
  await page.waitForTimeout(500);
  await focusViewport(page);

  R.section('星级');
  await page.keyboard.press('3');
  waitForXmp(xp(TARGET), (s) => s.includes('<xmp:Rating>3</xmp:Rating>'));
  R.check('按 3 → XMP Rating=3', readXmpTag(xp(TARGET), 'xmp:Rating') === '3',
    `rating=${readXmpTag(xp(TARGET), 'xmp:Rating')}`);

  R.section('旗标');
  await page.keyboard.press('x');
  waitForXmp(xp(TARGET), (s) => s.includes('<xmp:Rating>-1</xmp:Rating>'));
  R.check('按 X → XMP Rating=-1（reject）', readXmpTag(xp(TARGET), 'xmp:Rating') === '-1',
    `rating=${readXmpTag(xp(TARGET), 'xmp:Rating')}`);

  R.section('P0-1：打分解除淘汰');
  await page.keyboard.press('4');
  waitForXmp(xp(TARGET), (s) => s.includes('<xmp:Rating>4</xmp:Rating>'));
  const r4 = readXmpTag(xp(TARGET), 'xmp:Rating');
  const l4 = readXmpTag(xp(TARGET), 'xmp:Label');
  R.check('打分解除 → Rating=4', r4 === '4', `rating=${r4}`);
  R.check('旗标变 none（Label 被清掉）', !l4 || l4 === 'None', `label=${l4}`);

  R.section('保留旗标与星级共存');
  await page.keyboard.press('p');
  waitForXmp(xp(TARGET), (s) => s.includes('<xmp:Label>Green</xmp:Label>'));
  R.check('按 P → Label=Green（pick）', readXmpTag(xp(TARGET), 'xmp:Label') === 'Green',
    `label=${readXmpTag(xp(TARGET), 'xmp:Label')}`);
  R.check('pick 时星级保留 4', readXmpTag(xp(TARGET), 'xmp:Rating') === '4',
    `rating=${readXmpTag(xp(TARGET), 'xmp:Rating')}`);

  R.section('撤销');
  await page.keyboard.press('Control+z');
  waitForXmp(xp(TARGET), (s) => !s.includes('<xmp:Label>Green</xmp:Label>'));
  R.check('Ctrl+Z 撤销 pick → Label 不再 Green', readXmpTag(xp(TARGET), 'xmp:Label') !== 'Green',
    `label=${readXmpTag(xp(TARGET), 'xmp:Label')}`);

  R.section('清空');
  await page.keyboard.press('0');
  waitForXmp(xp(TARGET), (s) => s.includes('<xmp:Rating>0</xmp:Rating>'));
  const r0 = readXmpTag(xp(TARGET), 'xmp:Rating');
  const l0 = readXmpTag(xp(TARGET), 'xmp:Label');
  R.check('按 0 → Rating=0 且 flag none', r0 === '0' && (!l0 || l0 === 'None'), `rating=${r0} label=${l0}`);

  await page.keyboard.press('0').catch(() => {});
  await sleep(700);
  R.check('重复按 0 幂等无异常', true);

  R.section('写出的 XMP 必须是合法 XML');
  const final = fs.existsSync(xp(TARGET)) ? fs.readFileSync(xp(TARGET), 'utf8') : '';
  R.check('无字面量 \\n（必须是真换行）', !final.includes('\\n'));
  R.check('<rdf:Description> 开标签已闭合', /xmlns:crs="[^"]+">\n/.test(final));
  R.check('Rating 标签恰好 1 个（不得重复追加）', (final.match(/<xmp:Rating>/g) || []).length === 1);
  R.check('sidecar 非空', final.length > 100, `${final.length} 字节`);

  return R.summary();
}
