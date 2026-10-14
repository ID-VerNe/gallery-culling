/**
 * e2e 测试基座：CDP 连接、弹窗清理、断言与报告。
 *
 * 与 `src/test/setup.ts`（vitest 基座）的分工：
 *   vitest —— mock 掉 Tauri IPC，跑组件/hook 逻辑，快；
 *   本基座 —— 连真实窗口与真实 Rust 后端，跑磁盘副作用，慢但可信。
 */
import { chromium } from 'playwright-core';
import { CDP_URL } from './app.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 连上正在运行的 Tauri 窗口。 */
export async function connect({ verbose = false } = {}) {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('没有 browser context');
  const page = ctx.pages().find((p) => p.url().includes('1420')) || ctx.pages()[0];
  if (!page) throw new Error('没找到应用页面（CDP 里没有 1420 的 page target）');

  const errors = [];
  if (verbose) {
    page.on('console', (m) => {
      if (m.type() === 'error') console.log(`    [console.error] ${m.text()}`);
    });
  }
  page.on('pageerror', (e) => errors.push(e.message));
  await page.bringToFront();
  return { browser, page, errors };
}

/**
 * 关掉任何遗留弹窗（上一轮崩在中间 / 自动更新提示 / 未保存确认）。
 * 弹窗背景会拦截点击，不清掉后续所有交互定位都会失败。
 */
export async function clearModals(page, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const dlg = page.locator('[role="dialog"][aria-modal="true"]');
    if (!(await dlg.count())) return true;
    const cancel = dlg.getByRole('button', { name: /取消|关闭|稍后|以后|知道了|×/ }).first();
    if (await cancel.count()) await cancel.click({ timeout: 2500 }).catch(() => {});
    else await page.keyboard.press('Escape').catch(() => {});
    await sleep(400);
  }
  return (await page.locator('[role="dialog"][aria-modal="true"]').count()) === 0;
}

/** 底栏「N / M」计数器。 */
export async function readCounter(page) {
  // 用一次 evaluate 取完，不要拿元素句柄再逐个 innerText ——
  // 扫描/排序重渲染会让句柄失效（表现为 nth(k) 超时）。
  return page.evaluate(() => {
    for (const s of document.querySelectorAll('[role="status"]')) {
      const t = (s.textContent || '').trim();
      if (/^\d+\s*\/\s*\d+$/.test(t)) return t;
    }
    return '?';
  });
}

/** 底栏当前照片名（排除宫格里同名的文字）。 */
export async function readBaseName(page) {
  return page.evaluate(() => {
    const el = [...document.querySelectorAll('span.font-semibold')].find((s) =>
      /^[A-Z]+_\w+$/.test(s.innerText.trim()),
    );
    return el ? el.innerText.trim() : '?';
  });
}

/** 宫格单元格的 aria-label 列表。 */
export async function readCells(page) {
  return page.$$eval('[role="option"]', (els) => els.map((e) => e.getAttribute('aria-label') || ''));
}

/** 筛选下拉每一档的 {mode, 文案, 计数}。 */
export async function readFilterOptions(page) {
  return page.getByLabel('照片筛选过滤').evaluate((s) =>
    [...s.options].map((o) => ({ mode: o.value, label: o.text, count: Number((o.text.match(/\((\d+)\)/) || [])[1]) })),
  );
}

/** 把焦点交给主视口（全局单键快捷键在 input/dialog 内会被让位）。 */
export async function focusViewport(page) {
  await page.locator('body').click({ position: { x: 700, y: 520 } }).catch(() => {});
  await sleep(180);
}

/** 扫描到就绪（底栏出现 N / M）。 */
/** Windows 路径统一成正斜杠：应用侧两种都吃，正斜杠在 CDP 传值里最不容易被转义坑到。 */
export const toPosix = (p) => String(p).split(String.fromCharCode(92)).join('/');

export async function scanAndWait(page, { jpgFolder, rawFolder = '' } = {}) {
  if (jpgFolder) await page.getByLabel('JPG 照片文件夹路径').fill(toPosix(jpgFolder));
  await page.getByLabel('RAW 原片文件夹路径（可选）').fill(toPosix(rawFolder));
  await sleep(150);
  await page.getByRole('button', { name: '扫描照片目录' }).click();
  await page.waitForFunction(() => /\d+\s*\/\s*\d+/.test(document.body.innerText), { timeout: 120_000 });
  await sleep(700);
}

/** 断言收集器：失败不抛，跑到最后统一汇总（便于一次跑出所有问题）。 */
export function createReporter(suiteName) {
  const results = [];
  return {
    check(name, pass, detail = '') {
      const ok = Boolean(pass);
      results.push({ name, ok, detail });
      console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  :: ${detail}` : ''}`);
      return ok;
    },
    note(msg) {
      console.log(`  ----  ${msg}`);
    },
    section(title) {
      console.log(`\n  [${title}]`);
    },
    get failures() {
      return results.filter((r) => !r.ok);
    },
    summary() {
      const bad = results.filter((r) => !r.ok);
      console.log(`\n[${suiteName}] ${results.length - bad.length}/${results.length} passed`);
      if (bad.length) {
        console.log(`[${suiteName}] FAILED (${bad.length}):`);
        for (const b of bad) console.log(`   - ${b.name}${b.detail ? `  :: ${b.detail}` : ''}`);
      }
      return { total: results.length, failed: bad.length, failures: bad };
    },
  };
}

/** 读回 fixture 里的 XMP 某个标签（同步读磁盘，不经页面）。 */
export function readXmpTag(xmpPath, tag) {
  if (!fsExists(xmpPath)) return null;
  const content = readFileSafe(xmpPath);
  const m = content.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1] : null;
}

import fs from 'node:fs';
const fsExists = (p) => fs.existsSync(p);
const readFileSafe = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

/** 等 sidecar 满足条件（轮询磁盘）。 */
export function waitForXmp(xmpPath, pred, { timeoutMs = 8000 } = {}) {
  const t0 = Date.now();
  let content = readFileSafe(xmpPath);
  while (Date.now() - t0 < timeoutMs) {
    content = readFileSafe(xmpPath);
    if (content && pred(content)) return content;
  }
  return content;
}
