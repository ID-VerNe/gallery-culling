import fs from 'node:fs';
import path from 'node:path';
import { createReporter, scanAndWait, sleep } from '../lib/harness.mjs';
import { JPG, OUT, EXPECTED, PAIRED_STEMS } from '../fixtures/generate.mjs';

export const name = '05-export';

/** ★3 档在纯 JPG 素材下命中的词干（从 EXPECTED 推导，不另抄一份）。 */
const STAR3 = Object.entries(EXPECTED)
  .filter(([k, v]) => k !== 'RAW_ONLY_009' && v.rating >= 3)
  .map(([k]) => k);

export async function run({ page, browser }) {
  const R = createReporter(name);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  await scanAndWait(page, { jpgFolder: JPG, rawFolder: '' });

  R.section('打开弹窗');
  await page.getByRole('button', { name: '批量挑选导出照片' }).click();
  await sleep(700);
  const dlg = page.locator('[role="dialog"][aria-modal="true"]');
  R.check('导出弹窗打开', (await dlg.count()) > 0);
  const target = dlg.locator('#export-target-folder');
  const go = dlg.getByRole('button', { name: /开始导出|确认导出/ }).first();

  R.section('同目录护栏');
  await target.fill(JPG);
  await sleep(500);
  const alerts = await dlg.locator('[role="alert"]').allInnerTexts();
  R.check('目标=源目录时给出告警', alerts.length > 0, alerts.join(';'));
  R.check('目标=源目录时导出按钮禁用', !(await go.isEnabled()));
  R.check('目标输入标记 aria-invalid', (await target.getAttribute('aria-invalid')) === 'true');

  R.section('选档并导出');
  await target.fill(OUT);
  await sleep(400);
  R.check('合法目标后导出按钮恢复可用', await go.isEnabled());
  const star3 = dlg.locator('label', { hasText: /3\s*星以上/ }).first();
  if (await star3.count()) { await star3.click(); await sleep(400); } else R.note('未找到 ★3 档单选，使用默认档');
  const confirm = dlg.getByRole('button', { name: /确认导出|确定/ }).first();
  if ((await confirm.count()) && (await confirm.isEnabled())) { await confirm.click(); await sleep(500); }
  await go.click();
  await page.waitForFunction(() => /已导出|导出完成/.test(document.body.innerText), { timeout: 90_000 }).catch(() => {});
  await sleep(800);
  R.note('结果：' + (await dlg.innerText()).split('\n').filter(Boolean).slice(-6).join(' / '));

  R.section('落盘校验');
  const files = fs.existsSync(OUT) ? fs.readdirSync(OUT) : [];
  const jpgs = files.filter((f) => /\.jpe?g$/i.test(f));
  R.note('OUT: ' + files.join(', '));
  R.check(`导出产出 ${STAR3.length} 个 JPG（实际 ${jpgs.length}）`, jpgs.length === STAR3.length, jpgs.join(','));
  R.check('文件名与来源一致', STAR3.every((s) => jpgs.includes(`${s}.jpg`)), jpgs.join(','));
  const sizes = jpgs.map((f) => fs.statSync(path.join(OUT, f)).size);
  const src = STAR3.map((s) => fs.statSync(path.join(JPG, `${s}.jpg`)).size);
  R.check('复制字节数与源一致', sizes.length === src.length && sizes.every((v, i) => v === src[i]), `${sizes} vs ${src}`);
  R.check('写入 .gallery-export.json manifest', files.includes('.gallery-export.json'));
  R.check('无残留临时目录', !files.some((f) => f.includes('.gallery-export-tmp-')));

  return R.summary();
}
