import { createReporter, readCounter, readBaseName, readCells, scanAndWait, sleep, focusViewport } from '../lib/harness.mjs';
import { JPG } from '../fixtures/generate.mjs';

export const name = '03-nav';

const modeOf = (page) => page.evaluate(() => {
  const g = document.querySelector('[aria-label="视图检视模式"]');
  const on = g && [...g.querySelectorAll('button')].find((b) => b.getAttribute('aria-pressed') === 'true');
  return on ? on.innerText.trim() : '?';
});

export async function run({ page, browser }) {
  const R = createReporter(name);
  await scanAndWait(page, { jpgFolder: JPG, rawFolder: '' });

  R.section('键盘导航');
  await page.locator('[role="option"]').first().click();
  await sleep(300);
  await focusViewport(page);
  R.check('起始为第 1 张', (await readCounter(page)) === '1 / 12', await readCounter(page));

  await page.keyboard.press('d');
  await sleep(350);
  R.check('按 D 前进到第 2 张', (await readCounter(page)) === '2 / 12', await readCounter(page));
  R.check('底栏显示 IMG_002', (await readBaseName(page)) === 'IMG_002', await readBaseName(page));

  await page.keyboard.press('a');
  await sleep(350);
  R.check('按 A 回到第 1 张', (await readCounter(page)) === '1 / 12', await readCounter(page));

  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await sleep(500);
  R.check('方向键 →→ 到第 3 张', (await readCounter(page)) === '3 / 12', await readCounter(page));

  R.section('宫格作用域按键 Home');
  await page.locator('[role="option"]').first().click();
  await sleep(300);
  await page.keyboard.press('Home');
  await sleep(400);
  R.check('宫格获焦后 Home 跳首张', (await readCounter(page)) === '1 / 12', await readCounter(page));

  R.section('首张不越界');
  await focusViewport(page);
  await page.keyboard.press('a');
  await sleep(400);
  R.check('首张按 A 不越界', (await readCounter(page)) === '1 / 12', await readCounter(page));

  R.section('视图模式');
  R.check('初始为单图', (await modeOf(page)) === '单图', await modeOf(page));
  await page.keyboard.press('c');
  await sleep(600);
  R.check('按 C 进入对比', (await modeOf(page)) === '对比', await modeOf(page));
  await page.keyboard.press('s');
  await sleep(400);
  R.check('对比态按 S 交换两侧无异常', (await modeOf(page)) === '对比');
  await page.keyboard.press('c');
  await sleep(500);
  R.check('再按 C 回单图', (await modeOf(page)) === '单图', await modeOf(page));

  await page.keyboard.press('y');
  await sleep(600);
  R.check('按 Y 进入前后', (await modeOf(page)) === '前后', await modeOf(page));
  await page.keyboard.press('y');
  await sleep(500);
  R.check('再按 Y 回单图', (await modeOf(page)) === '单图', await modeOf(page));

  R.section('缩放');
  await focusViewport(page);
  const box = await page.locator('img').first().boundingBox();
  if (box) {
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -120); await sleep(70); }
    await sleep(350);
    const z1 = await page.locator('body').innerText();
    R.check('滚轮放大后出现缩放读数', /\d+%/.test(z1), (z1.match(/[^\n]*\d+%/) || [''])[0]);
    await page.mouse.dblclick(cx, cy);
    await sleep(400);
    const z2 = await page.locator('body').innerText();
    R.check('双击切换缩放档位', z2 !== z1);
  } else R.note('视口无 img，跳过缩放断言');

  R.section('搜索与双计数');
  await page.getByRole('button', { name: '按文件名搜索' }).click();
  await sleep(350);
  const search = page.getByPlaceholder(/搜索/).first();
  await search.fill('IMG_00');
  await sleep(700);
  R.check('搜索 IMG_00 命中 9 张', (await page.locator('[role="option"]').count()) === 9);
  R.check('搜索期显示「宫格筛选中」徽标', /宫格筛选中/.test(await page.locator('body').innerText()));

  await search.fill('IMG_003');
  await sleep(600);
  const cells = await readCells(page);
  R.check('搜索 IMG_003 只剩 1 张', cells.length === 1 && /IMG_003/.test(cells[0]), cells.join('|'));

  await search.press('Escape');
  await sleep(700);
  R.check('Esc 后宫格恢复 12 张', (await page.locator('[role="option"]').count()) === 12);
  R.check('Esc 后搜索徽标消失', !/宫格筛选中/.test(await page.locator('body').innerText()));
  // 搜索期间当前照片被收窄到 IMG_003（第 3 张）；Esc 恢复全集后应**保留**它
  R.check('Esc 后保留当前照片 IMG_003', (await readBaseName(page)) === 'IMG_003', await readBaseName(page));
  R.check('Esc 后计数为 3 / 12', (await readCounter(page)) === '3 / 12', await readCounter(page));

  R.section('宫格多选');
  const opts = await page.locator('[role="option"]').all();
  await opts[0].click(); await sleep(200);
  await opts[1].click({ modifiers: ['Control'] }); await sleep(250);
  await opts[2].click({ modifiers: ['Shift'] }); await sleep(400);
  const m = (await page.locator('body').innerText()).match(/已选\s*(\d+)/);
  R.check('Ctrl/Shift 多选生效', m && Number(m[1]) >= 2, m ? `已选 ${m[1]}` : '未读到已选数');

  return R.summary();
}
