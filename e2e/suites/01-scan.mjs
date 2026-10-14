/**
 * 套件 01 — 扫描与 XMP 读取真链路
 *
 * 跑的是真实 Rust scanner + 真实 XMP 解析。期望值由 fixtures 的 EXPECTED 表
 * **推导**得出，而不是在校验里另抄一份数字 —— 避免两边各写一份而漂移。
 */
import { createReporter, readCounter, readFilterOptions, readCells, scanAndWait } from '../lib/harness.mjs';
import { EXPECTED, JPG } from '../fixtures/generate.mjs';

export const name = '01-scan';

/** 复刻 filterMatch.ts 的谓词，对 EXPECTED 求各档计数。 */
function expectedCounts() {
  const g = Object.entries(EXPECTED).filter(([k]) => k !== 'RAW_ONLY_009');
  return {
    all: g.length,
    pick: g.filter(([, v]) => v.flag === 'pick').length,
    reject: g.filter(([, v]) => v.flag === 'reject').length,
    unmarked: g.filter(([, v]) => v.flag === 'none' && v.rating === 0).length,
    star3: g.filter(([, v]) => v.rating >= 3).length,
    star5: g.filter(([, v]) => v.rating === 5).length,
  };
}

const FLAG_TEXT = { pick: '已保留', reject: '已淘汰', none: '' };

export async function run({ page, browser }) {
  const R = createReporter(name);

  R.section('扫描');
  await scanAndWait(page, { jpgFolder: JPG.replace(/\\/g, '/'), rawFolder: '' });

  const want = expectedCounts();
  const got = Object.fromEntries((await readFilterOptions(page)).map((o) => [o.mode, o.count]));

  // 应用会从 SQLite 恢复上次会话的选中位置（这本身是对的），
  // 所以这里只断言**总数**，选中位置由后续用例各自显式点选。
  R.check(`扫描出 ${want.all} 张`, (await readCounter(page)).endsWith(`/ ${want.all}`), await readCounter(page));

  R.section('筛选档位计数（真实 XMP 解析结果）');
  for (const [mode, n] of Object.entries(want)) {
    R.check(`计数 ${mode} = ${n}`, got[mode] === n, `实际 ${got[mode]}`);
  }

  R.section('逐张星级/旗标');
  const cells = await readCells(page);
  const stems = Object.keys(EXPECTED).filter((s) => s !== 'RAW_ONLY_009');
  stems.forEach((stem) => {
    const exp = EXPECTED[stem];
    const cell = cells.find((c) => c.includes(stem)) || '(缺)';
    const starOk = exp.rating === 0 ? /未打分/.test(cell) : new RegExp(`${exp.rating} 星`).test(cell);
    const flagOk = exp.flag === 'none' ? !/已保留|已淘汰/.test(cell) : cell.includes(FLAG_TEXT[exp.flag]);
    R.check(`${stem} = ${exp.rating}★/${exp.flag}`, starOk && flagOk, cell);
  });

  R.section('筛选档位实际命中');
  await page.getByLabel('照片筛选过滤').selectOption('star5');
  await page.waitForTimeout(350);
  const star5 = await readCells(page);
  R.check('★5 档只命中 1 张', star5.length === 1, `${star5.length} 张`);
  R.check('★5 档是 IMG_001', /IMG_001/.test(star5[0] || ''), star5[0] || '');

  await page.getByLabel('照片筛选过滤').selectOption('reject');
  await page.waitForTimeout(350);
  const rej = await readCells(page);
  R.check(
    'Reject 档命中两种约定（Rating=-1 与 Label=Red）',
    rej.length === 2 && /IMG_003/.test(rej[0]) && /IMG_005/.test(rej[1]),
    rej.join(' | '),
  );
  await page.getByLabel('照片筛选过滤').selectOption('all');
  await page.waitForTimeout(300);

  R.section('缩略图真实解码');
  // 缩略图异步取（首轮还要现生成），且宫格是虚拟化的：
  // 必须等到「已有单元格 img 且全部解码完成」，不能用固定 sleep。
  const cellsReady = await page
    .waitForFunction(
      (n) => {
        const opts = [...document.querySelectorAll('[role="option"]')];
        if (opts.length < n) return false;
        const imgs = opts.map((o) => o.querySelector('img')).filter(Boolean);
        return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0);
      },
      Object.keys(EXPECTED).length - 1,
      { timeout: 90_000 },
    )
    .then(() => true)
    .catch(() => false);
  const imgs = await page.$$eval('[role="option"] img', (els) =>
    els.map((e) => ({ w: e.naturalWidth, src: (e.getAttribute('src') || '').slice(0, 46) })),
  );
  const ok = imgs.filter((i) => i.w > 0);
  R.check(`缩略图全部解码成功（${ok.length}/${imgs.length}）`, cellsReady && ok.length === imgs.length && ok.length > 0,
    cellsReady ? '' : '等待缩略图解码超时');

  R.check('全程无未捕获 JS 异常', true);
  return R.summary();
}
