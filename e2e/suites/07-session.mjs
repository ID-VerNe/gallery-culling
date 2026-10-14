import { createReporter, connect, clearModals, readCounter, readBaseName, scanAndWait, sleep } from '../lib/harness.mjs';
import { restartApp } from '../lib/app.mjs';
import { JPG } from '../fixtures/generate.mjs';

export const name = '07-session';

export async function run({ page, browser }) {
  const R = createReporter(name);

  R.section('关闭前建立状态');
  await scanAndWait(page, { jpgFolder: JPG, rawFolder: '' });
  await page.locator('[role="option"]').first().click();
  await sleep(300);
  await page.locator('body').click({ position: { x: 700, y: 520 } }).catch(() => {});
  await sleep(200);
  for (let i = 0; i < 6; i++) { await page.keyboard.press('d'); await sleep(220); }
  await sleep(300);
  R.check('关闭前停在第 7 张', (await readCounter(page)) === '7 / 12', await readCounter(page));
  R.check('关闭前当前照片为 IMG_007', (await readBaseName(page)) === 'IMG_007', await readBaseName(page));

  await page.getByLabel('照片排序方式').selectOption('filename');
  await sleep(1400); // 越过 500ms 防抖 + 落盘
  R.check('排序切到「文件名排序」', (await page.getByLabel('照片排序方式').inputValue()) === 'filename');

  R.section('优雅关闭并重启');
  await browser.close();
  await restartApp();
  R.check('应用重启后 CDP 就绪', true);
  await sleep(6000);

  const again = await connect();
  await again.page.bringToFront();
  await clearModals(again.page);

  // 设置读回是异步 IPC，固定 sleep 会 flaky：直接等输入框被回填。
  const jpgInput = again.page.getByLabel('JPG 照片文件夹路径');
  await jpgInput
    .evaluate((el) => new Promise((res) => {
      if (el.value) return res(true);
      const t = setInterval(() => {
        if (el.value) {
          clearInterval(t);
          res(true);
        }
      }, 200);
      setTimeout(() => {
        clearInterval(t);
        res(false);
      }, 20_000);
    }))
    .catch(() => {});

  // 重启后应用**刻意不自动扫描**（useFolderScan 里 sortOrderInitialised 的
  // 守卫注释写明了：恢复设置不该静默触发一次扫描）。所以这里分两步验证：
  //   1) 设置层：目录与排序被回填；
  //   2) 会话层：点一次扫描，load_session_cmd 把上次的选中位置还原。
  const jpgVal = await jpgInput.inputValue();
  R.check(
    '重启后记住 JPG 目录',
    jpgVal.replaceAll(String.fromCharCode(92), '/') === JPG.replaceAll(String.fromCharCode(92), '/'),
    jpgVal || '(空)',
  );
  R.check('重启后记住排序方式', (await again.page.getByLabel('照片排序方式').inputValue()) === 'filename');

  // 重启后是否自动扫描取决于「保存的排序 == 默认排序」：
  // useFolderScan 的 sortOrderInitialised 守卫只吞掉第一次 effect，
  // 设置回填把 sortOrder 从默认的 time_filename 改成 filename 时会再触发一次，
  // 于是这里会自己扫一遍。两种路径都接受 —— 断言用户可见的最终契约：
  // 目录、排序、上次选中的位置都回来了。
  const beforeScanCounter = await readCounter(again.page);
  R.note(`重启后（未手动扫描）counter=${beforeScanCounter}`);

  R.section('会话位置还原');
  if (beforeScanCounter === '0 / 0') {
    // 也可能自动扫描正在进行中，先轮询等它落定再判断
    const t0 = Date.now();
    while (Date.now() - t0 < 15_000 && (await readCounter(again.page)) === '0 / 0') {
      await sleep(700);
    }
    if ((await readCounter(again.page)) === '0 / 0') {
      await scanAndWait(again.page, { jpgFolder: JPG, rawFolder: '' });
    }
  }
  await sleep(1200);
  const counter = await readCounter(again.page);
  const base = await readBaseName(again.page);
  R.note(`重启后 counter=${counter} base=${base}`);
  R.check('重启后恢复到选中索引 7/12', counter === '7 / 12', counter);
  R.check('重启后当前照片为 IMG_007', base === 'IMG_007', base);
  await again.browser.close();

  return R.summary();
}
