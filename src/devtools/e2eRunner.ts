/**
 * dev-only e2e 自测执行器。
 *
 * 为什么存在：本机 WebView2 的 `--remote-debugging-port` 只服务第一个 HTTP
 * 请求，之后永久卡死（HTTP 与 WS 通道均已实测确认，Edge 同版本内核正常）。
 * 详见 `.plan/lumen-preset-autotone-console-diagnosis-2026-10-15.md`。
 * 因此 Playwright `connectOverCDP` 在 WebView2 上不可用，改为「应用内驱动」：
 * 直接操作真实 DOM（点击 / 键盘 / 受控组件原生 setter），走完整
 * 前端 → Tauri IPC → Rust → lumen-cli sidecar 链路，每步日志 POST 到
 * Vite 的 `/__e2e_log` 中间件落盘，外部脚本读 `e2e/.tmp/e2e-app.log`。
 *
 * 场景（由 `VITE_E2E_SCENARIO` 选择）：
 *   - `load-photos`：只扫描并加载照片，不做任何操作。给真机目视复核（截图）用
 *   - `lumen-preset`：LUMEN RAW 预设 + 自动调色（用 `VITE_E2E_JPG`）
 *   - `render-export`：调色成片导出（`VITE_E2E_JPG` + `VITE_E2E_RAW` + `VITE_E2E_OUT`）
 *   - `detail-1to1`：RAW-only 1:1 细节（`VITE_E2E_RAW` 必须是**真实 ARW**，
 *     `VITE_E2E_NAMES` 给两张的 baseName）
 *   - `ui-contract`：主视口底栏的命中 / 静息收起 / 左手别名真窗口契约（issue #53）
 *
 * 触发：`npm run e2e:render` / `npm run e2e:preset` / `npm run e2e:ui`（见 `e2e/run-inapp.mjs`），
 * 或手动 `VITE_E2E_SCENARIO=<场景> … npm run tauri dev`。
 * 生产构建不包含本模块（`import.meta.env.DEV` 为 false 时被 tree-shake）。
 */

const LOG_ENDPOINT = '/__e2e_log';

let seq = 0;

/** 记一行日志：console + POST 落盘（顺序由 seq 保证可读）。 */
function raw(msg: string) {
  seq += 1;
  const line = `${String(seq).padStart(3, '0')} ${msg}`;
  console.log('[e2e]', line);
  try {
    void fetch(LOG_ENDPOINT, { method: 'POST', body: line });
  } catch {
    /* 日志通道失败不影响场景执行 */
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 轮询直到 fn 返回真值；超时返回 null。 */
async function waitFor<T>(
  fn: () => T | null | undefined,
  timeoutMs: number,
  intervalMs = 250,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v: T | null | undefined = null;
    try {
      v = fn();
    } catch {
      v = null;
    }
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(intervalMs);
  }
}

/**
 * 找按钮：文本 / aria-label / title 任一 Trim 后 includes 即命中。
 *
 * 图标按钮（如顶栏「设置」）只有 aria-label 没有文本；扫描按钮的可见文案
 * 是「扫描照片」而 aria-label 才是「扫描照片目录」——只查 textContent 会漏。
 */
function findButton(text: string): HTMLButtonElement | null {
  const btns = Array.from(document.querySelectorAll('button'));
  return (
    (btns.find((b) => {
      if ((b.textContent || '').trim().includes(text)) return true;
      return (
        (b.getAttribute('aria-label') || '').includes(text) ||
        (b.getAttribute('title') || '').includes(text)
      );
    }) as HTMLButtonElement) || null
  );
}

/** 关掉可能出现的「未保存改动」确认框（点「放弃改动」放行）。 */
async function dismissDirtyDialog(el: () => string): Promise<void> {
  const dlg = document.querySelector('[role="dialog"]');
  if (!dlg) return;
  const discard = findButton('放弃改动');
  raw(`[${el()}] 检测到确认框，「放弃改动」按钮 = ${!!discard}`);
  if (!discard) {
    raw(`[${el()}] 对话框快照: ${(dlg.textContent || '').replace(/\s+/g, ' ').slice(0, 240)}`);
    return;
  }
  discard.click();
  await sleep(700);
}

/**
 * 给 React 受控组件赋值：直接改 `el.value` 会被 React 的 value 拦截器吞掉，
 * 必须用原型上的原生 setter，再派发原生 input/change 让 React 收到。
 */
function setControlValue(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
) {
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
  if (desc && desc.set) desc.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** 读调色滑杆（排除 AI 蒙版去薄雾那条）。 */
function readSliders() {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[type="range"]'))
    .map((e) => ({
      name: (e.getAttribute('aria-label') || '').split('，')[0],
      value: Number(e.value),
    }))
    .filter((s) => !/蒙版/.test(s.name));
}

/**
 * 读**全部** aria-selected=true 的单元格文本。
 *
 * 选中是并集语义（`itemIndex === selectedIndex || activeIds.has(id)`），
 * 所以可能有 0~2 个元素命中：只打印 querySelector 的第一个会把「selectedIndex
 * 被翻走、靠 activeIds 残留高亮」误读成「选中正常」（run5 的 #10IMG_010 即此）。
 */
function readSelectedCells(): string {
  return (
    Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"][aria-selected="true"]'),
    )
      .map((o) => (o.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 16))
      .join(' | ') || '(无)'
  );
}

const sameSliders = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 派发单次键盘事件到 window（应用在 window 上监听 keydown）。
 *
 * `code` 必须显式传入：快捷键里所有「物理键位」分支（`Shift+1…5`、`Q`/`Shift+Q`）
 * 只看 `e.code`（见 `useKeyboardShortcuts.ts` 的 `LABEL_BY_DIGIT_CODE` 与
 * `e.code === 'KeyQ'`），而合成事件不会自带 `code`。此前本函数只给 `key`，
 * 等于让真窗口 e2e 永远测不到这些物理键位分支（issue #53）。
 */
function keyEvent(
  type: 'keydown' | 'keyup',
  key: string,
  code = '',
  shiftKey = false,
) {
  window.dispatchEvent(new KeyboardEvent(type, { key, code, shiftKey, bubbles: true }));
}

/** 一次完整的按键（down + up）。 */
function pressKey(key: string, code = '', shiftKey = false) {
  keyEvent('keydown', key, code, shiftKey);
  keyEvent('keyup', key, code, shiftKey);
}

/** 点宫格里 baseName 命中的单元格；返回是否点到。 */
async function clickCell(baseName: string, el: () => string): Promise<boolean> {
  const cell = await waitFor(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((o) =>
        (o.textContent || '').includes(baseName),
      ) || null,
    20_000,
    400,
  );
  if (!cell) {
    const names = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).map(
      (o) => (o.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24),
    );
    raw(`[${el()}] FATAL: 宫格中找不到 ${baseName}；可见单元格(${names.length}): ${JSON.stringify(names)}`);
    return false;
  }
  cell.click();
  // 选中态演化采样（200/500/800ms）：点击后若 selectedIndex 被异步操作
  // （会话恢复 / 扫描完成）翻走，并集语义下会在稍后多出一个高亮单元格 ——
  // 固定 800ms 后只查第一个匹配会把这种翻转掩盖掉（run5 的教训）。
  const marks: string[] = [];
  for (const d of [200, 300, 300]) {
    await sleep(d);
    marks.push(`${d}ms:${readSelectedCells()}`);
  }
  raw(`[${el()}] 已点击单元格 ${baseName}；选中态演化 = ${marks.join(' → ')}`);
  return true;
}

/** 确保 LUMEN 引擎开启（dev 库默认关闭，不开启则预设下拉不出现）。 */
async function ensureLumenEnabled(el: () => string) {
  const settingsBtn = findButton('设置');
  raw(`[${el()}] 「设置」按钮 = ${!!settingsBtn}`);
  if (!settingsBtn) return;
  settingsBtn.click();
  await sleep(1200);

  const toggle = await waitFor(
    () => document.querySelector<HTMLInputElement>('#settings-lumen-enabled'),
    10_000,
    300,
  );
  raw(`[${el()}] #settings-lumen-enabled = ${!!toggle}, checked = ${toggle?.checked}`);
  if (!toggle) return;

  if (!toggle.checked) {
    toggle.click();
    await sleep(400);
    const saveBtn = findButton('保存设置');
    raw(`[${el()}] 「保存设置」按钮 = ${!!saveBtn}`);
    saveBtn?.click();
    await sleep(2500);
    raw(`[${el()}] 已开启 LUMEN 引擎并保存设置`);
  } else {
    const cancelBtn = findButton('取消');
    cancelBtn?.click();
    await sleep(600);
  }
  // 1500ms 重探延迟 + lumen-cli --version + 能力探测
  await sleep(3500);
  raw(`[${el()}] 引擎就绪等待完成`);
}

/**
 * 填两个路径框 + 点扫描，等到「单元格齐 + 扫描按钮恢复可用」。
 *
 * 扫描完成的**可靠**信号是「宫格单元格数达到下限」**且**「扫描按钮恢复可用」，
 * 不能用底栏计数正则 —— 它在扫描**进行中**就命中「0 / 12」，12ms 即假阳性
 * （run5 实测）；此时 onScanned（setGroups + 会话恢复）尚未执行，随后到达的
 * 恢复会翻转用户刚点的选中（Bug B 的触发窗口）。按钮 disabled ↔
 * isLoading || scanTask.isRunning，恢复发生在 onScanned 之后，因此
 * 「单元格齐 + 按钮可用」= 扫描与会话恢复都已落地。
 *
 * `minCells` 由调用方给：只填 JPG 是 12 组；JPG + RAW 时 RAW-only 分组会多
 * 出一组（13）。给下限而不是精确值，是为了不被夹具微调绑死。
 */
async function scanFolders(
  jpgFolder: string,
  rawFolder: string,
  minCells: number,
  el: () => string,
): Promise<boolean> {
  const jpgInput = await waitFor(
    () => document.querySelector<HTMLInputElement>('input[aria-label="JPG 照片文件夹路径"]'),
    20_000,
    400,
  );
  const rawInput = document.querySelector<HTMLInputElement>(
    'input[aria-label="RAW 原片文件夹路径（可选）"]',
  );
  raw(`[${el()}] 路径输入框：JPG=${!!jpgInput} RAW=${!!rawInput}`);
  if (!jpgInput) {
    raw(`[${el()}] FATAL: 找不到 JPG 路径输入框`);
    return false;
  }
  setControlValue(jpgInput, jpgFolder);
  if (rawInput) setControlValue(rawInput, rawFolder);
  await sleep(400);
  raw(`[${el()}] 已填路径 jpg="${jpgInput.value}" raw="${rawInput?.value ?? ''}"`);

  const scanBtn = findButton('扫描照片目录');
  raw(`[${el()}] 「扫描照片目录」按钮 = ${!!scanBtn}`);
  if (!scanBtn) return false;
  scanBtn.click();

  const counted = await waitFor(
    () => {
      const n = document.querySelectorAll('[role="option"]').length;
      return n >= minCells && !scanBtn.disabled ? n : null;
    },
    120_000,
    400,
  );
  raw(
    `[${el()}] 扫描完成（单元格齐 ${counted ?? 0} / 下限 ${minCells} + 按钮恢复）= ${!!counted}`,
  );
  if (!counted) {
    raw(`[${el()}] body 快照: ${document.body.innerText.replace(/\s+/g, ' ').slice(0, 500)}`);
  }
  return !!counted;
}

/**
 * 场景：调色成片导出（render 模式）。
 *
 * 断言的是**不变量**，不是「LUMEN 一定成功」：本目录的 RAW 夹具是 JPEG 改后缀，
 * 走 RAW 的那几张渲染必然失败；纯 JPG 那几张则可能成功。「成功几张」取决于
 * 引擎能力，写死就会变成脆断言。无论哪种情况，下面这些都必须成立：
 *   1. 模式分叉彻底 —— 切到成片后复制选项消失、成片选项出现、footer 改「预计生成」；
 *   2. 失败不得伪装成成功 —— 有失败时必须是 alert，且正文不得出现
 *      「成片生成完成：」（这是导出这条最高危写入路径上最该守住的东西）；
 *   3. 单位正确 —— 成片模式的计数单位是「张」，不是复制模式的「个」。
 *
 * 落盘与清单的逐项对账在外部脚本（`e2e/run-inapp.mjs`）里做 —— 浏览器里
 * 读不到文件系统，这里只负责把「结果条说了什么」如实交出去。
 */
async function scenarioRenderExport(
  jpgFolder: string,
  rawFolder: string,
  outFolder: string,
  el: () => string,
) {
  if (!outFolder) {
    raw(`[${el()}] FATAL: 未提供 VITE_E2E_OUT（目标导出目录）`);
    return;
  }

  await ensureLumenEnabled(el);

  // 12 张 JPG + 4 张 RAW（3 组配对 + 1 组 RAW-only）→ 13 组。
  // 必须带上 RAW：配对组会走「RAW 优先」的渲染源，从而同时覆盖失败路径。
  if (!(await scanFolders(jpgFolder, rawFolder, 13, el))) return;

  raw(`===== 打开导出弹窗 =====`);
  const openBtn = findButton('批量挑选导出照片');
  raw(`[${el()}] 「批量挑选导出照片」按钮 = ${!!openBtn}`);
  if (!openBtn) return;
  openBtn.click();
  await sleep(900);

  const dlg = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
  raw(`[${el()}] 导出弹窗打开 = ${!!dlg}`);
  if (!dlg) {
    raw(`[${el()}] body 快照: ${document.body.innerText.replace(/\s+/g, ' ').slice(0, 500)}`);
    return;
  }

  // ── 切到「调色成片」────────────────────────────────────
  raw(`===== 切到调色成片 =====`);
  const renderRadio = dlg.querySelector<HTMLInputElement>('#export-mode-render');
  raw(`[${el()}] 「调色成片」单选框 = ${!!renderRadio}`);
  if (!renderRadio) return;
  renderRadio.click();
  await sleep(700);

  // 分叉断言：两套选项不能并存，否则用户不知道自己在配哪一套
  const dlgText = dlg.innerText;
  raw(`[${el()}] >>> 断言R1 复制选项已隐藏 = ${!dlg.querySelector('#export-include-raw')}`);
  raw(`[${el()}] >>> 断言R2 出现成片格式选项 = ${!!dlg.querySelector('#export-format-jpg')}`);
  raw(`[${el()}] >>> 断言R3 出现长边档位 = ${!!dlg.querySelector('#export-long-edge')}`);
  raw(`[${el()}] >>> 断言R4 出现 JPEG 质量输入 = ${!!dlg.querySelector('#export-quality')}`);
  raw(`[${el()}] >>> 断言R5 footer 改为「预计生成」= ${/预计生成/.test(dlgText)}`);
  // 默认档「已保留或已打星」里 IMG_006 是 JPG-only → 二次压缩提示应出现。
  // 这条是「提示而非禁用」的现场证据：提示在，按钮仍然可用（下面会点它）。
  raw(`[${el()}] >>> 断言R12 JPG 源二次压缩提示 = ${/二次压缩/.test(dlgText)}`);

  // ── 范围 + 目标 ────────────────────────────────────────
  // 默认档「已保留或已打星」在夹具上只会命中 4 组；切到「全部非淘汰照片」
  // 才能把「配对组（走假 RAW → 必失败）」和「纯 JPG 组（可能成功）」同时纳入，
  // 一次运行覆盖成功与失败两条路径。
  const allRadio = dlg.querySelector<HTMLInputElement>('#export-filter-all');
  raw(`[${el()}] 「全部非淘汰照片」单选框 = ${!!allRadio}`);
  if (!allRadio) return;

  /** 从 footer 读「预计生成：N 张成片」；读不到返回 -1（便于断言区分「0」与「没读到」）。 */
  const readCandidates = () => {
    const hit = dlg.innerText.match(/预计生成[：:]\s*(\d+)/);
    return hit ? Number(hit[1]) : -1;
  };

  allRadio.click();
  await sleep(500);
  const allCount = readCandidates();
  raw(`[${el()}] 全部非淘汰候选数 = ${allCount}`);

  // 「仅含 RAW 的组」：按文件类型筛，同样不推翻「淘汰永不导出」的语义。
  // 夹具里 4 组带 RAW（IMG_001/002/004 配对 + RAW_ONLY_009），应严格少于全部。
  const rawRadio = dlg.querySelector<HTMLInputElement>('#export-filter-raw_only');
  raw(`[${el()}] 「仅含 RAW 的组」单选框 = ${!!rawRadio}`);
  let rawOnlyCount = -1;
  if (rawRadio) {
    rawRadio.click();
    await sleep(600);
    rawOnlyCount = readCandidates();
    raw(`[${el()}] 仅含 RAW 候选数 = ${rawOnlyCount}`);
    // 切回「全部」：后面的导出断言仍按全部非淘汰的候选集
    allRadio.click();
    await sleep(600);
  }
  raw(
    `[${el()}] >>> 断言R11 仅含 RAW 档存在且候选更少 = ${
      !!rawRadio && rawOnlyCount > 0 && rawOnlyCount < allCount
    }（${rawOnlyCount} < ${allCount}）`,
  );

  const targetInput = dlg.querySelector<HTMLInputElement>('#export-target-folder');
  raw(`[${el()}] 目标目录输入框 = ${!!targetInput}`);
  if (!targetInput) return;
  setControlValue(targetInput, outFolder);
  await sleep(700);

  // ── 引擎门禁 ───────────────────────────────────────────
  const startBtn = findButton('开始生成成片');
  const gateAlerts = Array.from(dlg.querySelectorAll<HTMLElement>('[role="alert"]')).map((n) =>
    (n.textContent || '').replace(/\s+/g, ' ').trim(),
  );
  raw(
    `[${el()}] 引擎门禁 alert = ${
      gateAlerts.length ? JSON.stringify(gateAlerts) : '（无，引擎可用）'
    }`,
  );
  raw(`[${el()}] 「开始生成成片」按钮 = ${!!startBtn}, disabled = ${startBtn?.disabled}`);
  if (!startBtn) {
    raw(`[${el()}] body 快照: ${document.body.innerText.replace(/\s+/g, ' ').slice(0, 600)}`);
    return;
  }
  if (startBtn.disabled) {
    // 引擎不可用分支：这正是「门禁」的现场验证 —— 按钮禁用 + alert 说明原因
    raw(`[${el()}] >>> 断言R6 引擎不可用时按钮禁用 = true`);
    raw(`[${el()}] >>> 断言R7 引擎不可用时给出 alert = ${gateAlerts.length > 0}`);
    raw(`[${el()}] 场景结束（引擎不可用，未产生任何 invoke）`);
    return;
  }

  // ── 执行 ───────────────────────────────────────────────
  raw(`===== 执行成片导出 =====`);
  const tStart = Date.now();
  startBtn.click();

  // 结果条：role=alert（失败态）或 role=status（成功态）。
  // 要排除 LumenGateNotice 的 probing status，否则引擎探测慢时会把
  // 「正在检测 LUMEN」误当成结果条 —— 那是假阳性。
  const resultEl = await waitFor(
    () => {
      const nodes = Array.from(
        dlg.querySelectorAll<HTMLElement>('[role="alert"], [role="status"]'),
      );
      return nodes.find((n) => !/正在检测 LUMEN/.test(n.textContent || '')) ?? null;
    },
    180_000,
    500,
  );
  raw(
    `[${el()}] 结果条出现 = ${!!resultEl}（耗时 ${((Date.now() - tStart) / 1000).toFixed(1)}s）`,
  );
  await sleep(1500); // 等 Toast 与进度条收尾，避免读到中途状态

  // ── 结果呈现（关键：失败不得伪装成成功）────────────────
  raw(`===== 结果呈现 =====`);
  const finalText = dlg.innerText;
  const resultText = (resultEl?.textContent || '').replace(/\s+/g, ' ').trim();
  const alertCount = Array.from(dlg.querySelectorAll('[role="alert"]')).length;
  raw(`[${el()}] 结果正文: ${resultText || '(空)'}`);
  raw(
    `[${el()}] 弹窗尾部: ${finalText.split('\n').filter(Boolean).slice(-6).join(' / ').slice(0, 400)}`,
  );
  raw(`[${el()}] alert=${alertCount}`);

  const saysComplete = /成片生成完成：/.test(finalText);
  const saysPartial = /成片生成未完全成功/.test(finalText);
  raw(`[${el()}] >>> 断言R8 有失败时以 alert 呈现 = ${!saysPartial || alertCount > 0}`);
  raw(
    `[${el()}] >>> 断言R9 未把失败说成「成片生成完成」= ${!(alertCount > 0 && saysComplete)}`,
  );
  raw(`[${el()}] >>> 断言R10 结果用「张」为单位 = ${/已生成\s*\d+\s*张/.test(resultText)}`);

  // 交出读数供外部对账（浏览器读不到目录，账实比对在 run-inapp.mjs 里做）
  const ok = resultText.match(/已生成\s*(\d+)\s*张/);
  const bad = resultText.match(/失败\s*(\d+)\s*张/);
  raw(`[${el()}] >>> 读数 exported=${ok ? ok[1] : '?'} failed=${bad ? bad[1] : '0'}`);
  raw(`[${el()}] 场景结束`);
}

/** 按 DOM 顺序读一组元素 `aria-pressed` 快照（`1`/`0` 串，便于整体比较）。 */
function readPressed(selector: string): string {
  return Array.from(document.querySelectorAll<HTMLElement>(selector))
    .map((node) => (node.getAttribute('aria-pressed') === 'true' ? '1' : '0'))
    .join('');
}

const RATING_GROUP = '[aria-label="照片星级打分"] button';
const FLAG_GROUP = 'button[aria-label="标记保留 (Pick)"], button[aria-label="标记淘汰 (Reject)"]';
const LABEL_GROUP = '[aria-label="照片色标"] button';
const BEFORE_AFTER_BTN = 'button[aria-label="本张照片前后对照 (快捷键 T)"]';

/**
 * 场景：主视口状态栏的可交互契约（issue #53 · issue #62 改写）。
 *
 * 为什么需要它：#46（按钮点不动）、#47（静息没整条收起）、#45（左手别名）
 * 都是**只在真实浏览器里成立**的契约 —— 命中、层叠、几何。既有 vitest 用
 * jsdom，只能断言 `className` 里有没有某个类，类在不在 ≠ 浏览器里矩形在不在
 * 视口外、按钮能不能被 `elementFromPoint` 命中。
 *
 * issue #62 把悬浮底栏换成了文档流常驻状态栏，旧的「静息移出视口 + 手柄唤回」
 * 断言随之失效，但 #46/#47 的回归保护不能删掉，改成语义等价的三段：
 *   U1–U6  常驻：状态栏在照片区下方（不遮挡）、恒可见、手柄不存在、
 *          按钮可键盘聚焦、聚焦前后几何零位移
 *   U7–U8  命中：每个按钮中心 `elementFromPoint` 命中按钮自身（#46）
 *   U9–U14 左手别名与旧键在同一张照片上产生同一状态（#61，原 #45）
 *
 * 明确不做：#49 更新装完不自动重启依赖 NSIS 安装器与提权进程，应用内 e2e
 * 驱动不到，继续留人工回签。
 */
async function scenarioUiContract(jpgFolder: string, el: () => string) {
  // 只填 JPG（12 组）；RAW 留空，避免 RAW-only 分组干扰宫格下限。
  if (!(await scanFolders(jpgFolder, '', 12, el))) return;
  if (!(await clickCell('IMG_006', el))) return;

  const mounted = await waitFor(
    () => {
      const bar = document.querySelector('[data-status-bar]');
      const pane = document.querySelector('[data-status-pane]');
      return bar && pane ? true : null;
    },
    20_000,
    300,
  );
  raw(`[${el()}] >>> 断言U0 窗口底部状态栏挂载 = ${!!mounted}`);
  if (!mounted) {
    raw(`[${el()}] body 快照: ${document.body.innerText.replace(/\s+/g, ' ').slice(0, 500)}`);
    return;
  }
  // 视口图片首帧 + 字体回落后再量几何。
  await sleep(800);

  // ── 常驻：文档流占位、零遮挡（替代 #47 的「静息移出视口」几何）──
  // 旧方案（#47）把整条底板 translate 出视口，只有 4px 手柄留在屏幕上；
  // 新方案的等价保护是「状态栏在照片区下方，且照片区底部不被它盖住」。
  const barEl = document.querySelector<HTMLElement>('[data-status-bar]');
  const photoEl = document.querySelector<HTMLElement>('[data-viewport-photo]');
  if (!barEl || !photoEl) {
    raw(`[${el()}] 状态栏或照片区锚点缺失，后续断言中止`);
    return;
  }
  const barRect = barEl.getBoundingClientRect();
  const photoRect = photoEl.getBoundingClientRect();
  raw(
    `[${el()}] 状态栏 top=${barRect.top.toFixed(1)} bottom=${barRect.bottom.toFixed(
      1,
    )} h=${barRect.height.toFixed(1)} 照片区bottom=${photoRect.bottom.toFixed(
      1,
    )} innerHeight=${window.innerHeight}`,
  );
  raw(
    `[${el()}] >>> 断言U1 状态栏在照片区下方且不遮挡 = ${barRect.top >= photoRect.bottom - 1}`,
  );

  const barOpacity = Number(getComputedStyle(barEl).opacity);
  raw(
    `[${el()}] >>> 断言U2 状态栏常驻可见（不依赖 hover/手柄唤回） = ${
      barOpacity >= 0.95 && barRect.height > 0
    }`,
  );

  // 「腾出空间」的直接证据：照片区底部内侧一点不能被状态栏吞掉。
  const probeY = photoRect.bottom - 18;
  const probe = document.elementFromPoint(window.innerWidth / 2, probeY);
  const probeHitsBar = !!(probe && barEl.contains(probe));
  raw(
    `[${el()}] 照片区底部探针 y=${probeY.toFixed(1)} 命中=${
      probe ? probe.tagName : 'null'
    }`,
  );
  raw(`[${el()}] >>> 断言U2b 状态栏不拦截照片区点击 = ${!probeHitsBar}`);

  // #47 的 4px 手柄已随悬浮方案一起删除（issue #62）。这里断言它**不存在**，
  // 而不是把断言删掉 —— 旧方案若被谁偷偷加回来，U3 立刻红。
  const handle = document.querySelector<HTMLElement>('[data-bar-handle]');
  raw(`[${el()}] >>> 断言U3 旧悬浮手柄已移除 = ${!handle}`);

  // 键盘可达：状态栏的星级按钮（旧底栏的等价入口）必须能被 Tab/焦点触达。
  const firstStar = document.querySelector<HTMLButtonElement>(
    '[aria-label="照片星级打分"] button',
  );
  firstStar?.focus();
  raw(
    `[${el()}] >>> 断言U4 状态栏按钮可键盘聚焦 = ${
      !!firstStar && document.activeElement === firstStar
    }`,
  );

  // 常驻占位：状态栏落在窗口底部之内，而不是被裁掉或浮在照片上。
  raw(
    `[${el()}] >>> 断言U5 状态栏在窗口底部之内 = ${
      barRect.bottom <= window.innerHeight + 1 && barRect.top < window.innerHeight
    }`,
  );

  // #47 的等价保护：聚焦前后几何零位移 —— 状态栏不再有「唤回」位移。
  firstStar?.blur();
  const restTop = barRect.top;
  firstStar?.focus();
  await sleep(300);
  const focusedRect = barEl.getBoundingClientRect();
  raw(
    `[${el()}] 聚焦前后 top=${restTop.toFixed(1)}→${focusedRect.top.toFixed(1)}`,
  );
  raw(
    `[${el()}] >>> 断言U6 聚焦不改变状态栏几何 = ${Math.abs(focusedRect.top - restTop) <= 1}`,
  );

  // ── 命中：每个按钮中心必须命中按钮自身（#46）─────────
  const bar = document.querySelector<HTMLElement>('[data-status-bar]');
  const buttons = bar
    ? Array.from(bar.querySelectorAll<HTMLButtonElement>('button')).filter((btn) => {
        const r = btn.getBoundingClientRect();
        return !btn.disabled && r.width > 0 && r.height > 0;
      })
    : [];
  const misses: string[] = [];
  for (const btn of buttons) {
    const r = btn.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const name =
      btn.getAttribute('aria-label') || (btn.textContent || '').trim().slice(0, 12) || '(无标签)';
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
      misses.push(`${name}@视口外(${x.toFixed(0)},${y.toFixed(0)})`);
      continue;
    }
    const hit = document.elementFromPoint(x, y);
    if (!hit || !btn.contains(hit)) {
      const hitName = hit
        ? `${hit.tagName}${hit.getAttribute('aria-label') ? `[${hit.getAttribute('aria-label')}]` : ''}`
        : 'null';
      misses.push(`${name}→${hitName}`);
    }
  }
  raw(
    `[${el()}] 命中检查：可点按钮 ${buttons.length} 个，未命中 ${misses.length} 个${
      misses.length ? `；明细=${JSON.stringify(misses.slice(0, 8))}` : ''
    }`,
  );
  raw(`[${el()}] >>> 断言U7 底栏可点按钮数量达标 = ${buttons.length >= 8}`);
  raw(`[${el()}] >>> 断言U8 每个按钮中心命中自身 = ${misses.length === 0}`);

  // ── 左手键：按住 V 查看原片；反斜杠已删除（#61）────────────
  const bannerVisible = () => /正在查看原片/.test(document.body.innerText);
  keyEvent('keydown', 'v', 'KeyV');
  await sleep(400);
  const holdV = bannerVisible();
  keyEvent('keyup', 'v', 'KeyV');
  await sleep(300);
  const holdVEnded = !bannerVisible();

  keyEvent('keydown', '\\', 'Backslash');
  await sleep(400);
  const holdBackslash = bannerVisible();
  keyEvent('keyup', '\\', 'Backslash');
  await sleep(300);
  const holdBackslashEnded = !bannerVisible();
  raw(`[${el()}] 按住 V=${holdV}/${holdVEnded} \\=${holdBackslash}/${holdBackslashEnded}`);
  raw(`[${el()}] >>> 断言U9 按住 V 出原片横幅、反斜杠不再触发 = ${holdV && !holdBackslash}`);
  raw(`[${el()}] >>> 断言U10 松开后横幅消失 = ${holdVEnded && holdBackslashEnded}`);

  // ── 左手键：F 保留；P 已删除（#61）────────────────────
  // 先设成淘汰，确保后续读数区分「P 真的没生效」与「本来就是 pick」。
  pressKey('x', 'KeyX');
  await sleep(300);
  pressKey('p', 'KeyP');
  await sleep(400);
  const flagAfterP = readPressed(FLAG_GROUP);
  pressKey('x', 'KeyX'); // 取消淘汰，回到无旗标
  await sleep(300);
  pressKey('f', 'KeyF');
  await sleep(400);
  const flagAfterF = readPressed(FLAG_GROUP);
  raw(`[${el()}] 保留：P 后=${flagAfterP} F 后=${flagAfterF}`);
  raw(
    `[${el()}] >>> 断言U11 P 不再改旗标（仍为淘汰）、F 仍可保留 = ${
      flagAfterP === '01' && flagAfterF === '10'
    }`,
  );

  // ── 左手键：R 清除；0 已删除（#61）──────────────────────
  pressKey('5', 'Digit5');
  await sleep(300);
  pressKey('0', 'Digit0');
  await sleep(400);
  const ratingAfterZero = readPressed(RATING_GROUP);
  pressKey('r', 'KeyR');
  await sleep(400);
  const ratingAfterR = readPressed(RATING_GROUP);
  raw(`[${el()}] 清零：0 后=${ratingAfterZero} R 后=${ratingAfterR}`);
  // 星级按钮的 aria-pressed 是累积语义（rating >= star），5 星读数即 `11111`。
  raw(
    `[${el()}] >>> 断言U12 0 不再清零（仍为 5 星）、R 仍清零 = ${
      ratingAfterZero === '11111' && ratingAfterR === '00000'
    }`,
  );

  // ── 星级 toggle：同键再按清零；不同键仍改分（issue #65）──────
  // R 之后读数为 00000，从 0 起步：1 → 1 星，1 → 0 星，再 1→2 → 2 星。
  pressKey('1', 'Digit1');
  await sleep(400);
  const ratingAfterOne = readPressed(RATING_GROUP);
  pressKey('1', 'Digit1');
  await sleep(700);
  const ratingAfterSameOne = readPressed(RATING_GROUP);
  pressKey('1', 'Digit1');
  await sleep(400);
  pressKey('2', 'Digit2');
  await sleep(700);
  const ratingAfterOneTwo = readPressed(RATING_GROUP);
  raw(
    `[${el()}] 星级 toggle：1 后=${ratingAfterOne} 再 1 后=${ratingAfterSameOne} 1→2 后=${ratingAfterOneTwo}`,
  );
  raw(
    `[${el()}] >>> 断言U12b 同键再按清零（1→1 回到 0 星）= ${
      ratingAfterOne === '10000' && ratingAfterSameOne === '00000'
    }`,
  );
  raw(
    `[${el()}] >>> 断言U12c 不同键仍改分（1→2 为 2 星）= ${
      ratingAfterOneTwo === '11000'
    }`,
  );
  pressKey('r', 'KeyR'); // 回到无星级/无旗标，避免影响后续色标用例
  await sleep(400);

  // ── 左手键：Shift+1…5 色标；6–9 / Shift+6 已删除（#61）───
  const leftLabelKeys: Array<[string, string]> = [
    ['!', 'Digit1'],
    ['@', 'Digit2'],
    ['#', 'Digit3'],
    ['$', 'Digit4'],
    ['%', 'Digit5'],
  ];
  const oldLabelKeys: Array<[string, string, boolean]> = [
    ['6', 'Digit6', false],
    ['7', 'Digit7', false],
    ['8', 'Digit8', false],
    ['9', 'Digit9', false],
    ['^', 'Digit6', true],
  ];
  const clearLabel = async () => {
    const state = readPressed(LABEL_GROUP);
    const idx = state.indexOf('1');
    if (idx < 0) return;
    const [key, code] = leftLabelKeys[idx];
    pressKey(key, code, true);
    await sleep(300);
  };

  const labelMismatches: string[] = [];
  for (let i = 0; i < leftLabelKeys.length; i += 1) {
    await clearLabel();
    const [key, code] = leftLabelKeys[i];
    pressKey(key, code, true);
    await sleep(500);
    const state = readPressed(LABEL_GROUP);
    const expected = ['10000', '01000', '00100', '00010', '00001'][i];
    const ok = state === expected;
    raw(`[${el()}] 色标 Shift+${i + 1}：读数=${state} 期望=${expected} 命中=${ok}`);
    if (!ok) labelMismatches.push(`Shift+${i + 1}: ${state}`);
  }
  await clearLabel();

  // 旧右手键逐个按下，色标必须保持全空。
  const oldStates: string[] = [];
  for (const [key, code, shift] of oldLabelKeys) {
    pressKey(key, code, shift);
    await sleep(300);
    oldStates.push(readPressed(LABEL_GROUP));
  }
  const oldAllEmpty = oldStates.every((state) => state === '00000');
  raw(`[${el()}] 旧色标键读数=${oldStates.join(' / ')}`);
  raw(
    `[${el()}] >>> 断言U13 只认 Shift+1…5，6–9/Shift+6 不再生效 = ${
      labelMismatches.length === 0 && oldAllEmpty
    }`,
  );

  // ── 左手键：T 前后对照；Y 已删除（#61）──────────────────
  // 放在最后：切前后对照会卸载单图视口，先做完底栏相关断言再动视图模式。
  const beforeAfterPressed = () =>
    document.querySelector<HTMLElement>(BEFORE_AFTER_BTN)?.getAttribute('aria-pressed') ===
    'true';

  pressKey('y', 'KeyY');
  await sleep(600);
  const baByY = beforeAfterPressed();
  pressKey('t', 'KeyT');
  await sleep(600);
  const baByT = beforeAfterPressed();
  raw(`[${el()}] 前后对照：Y=${baByY} T=${baByT}`);
  raw(`[${el()}] >>> 断言U14 Y 不再切换、T 仍切换 = ${!baByY && baByT}`);
  // 还原单图，保证下一次运行从同一状态开始（夹具会重建，但视图模式不该漂移）。
  pressKey('t', 'KeyT');
  await sleep(400);

  raw(`[${el()}] 场景结束`);
}

/**
 * 场景：只加载照片，不做任何操作。
 *
 * 用途：给真机目视复核（截图）准备一个「已扫出缩略图」的稳定起点。
 * 不点选、不改评级、不写盘，所以可以反复跑而不会污染 fixture。
 *
 * 完成信号沿用 `scanFolders` 的「按钮恢复」—— 那是唯一与扫盘本身同步的标志。
 * 但**单元格数不能借用 `minCells` 当前置条件**：这个场景拿到的目录由调用方
 * 决定，写死一个下限等于把结论建立在「夹具没变」上。所以下限给 1（只要出了
 * 东西就继续），真正的读数在下面**原样打印**，由读日志的人对照目录去核。
 */
async function scenarioLoadPhotos(jpgFolder: string, rawFolder: string, el: () => string) {
  if (!(await scanFolders(jpgFolder, rawFolder, 1, el))) return;
  const cells = document.querySelectorAll('[role="option"]').length;
  // 读数要能自己说明「扫的是哪些目录」，否则日志离开命令行上下文就不可核。
  raw(`[${el()}] >>> 读数 jpg="${jpgFolder}" raw="${rawFolder || '(未填)'}" loaded=${cells}`);
}

/** 场景：LUMEN RAW 预设（问题一）+ 自动调色（问题二）。 */
async function scenarioLumenPreset(jpgFolder: string, el: () => string) {
  // ── 前置：开启 LUMEN 引擎 ─────────────────────────────
  await ensureLumenEnabled(el);

  // ── 扫描 ──────────────────────────────────────────────
  if (!(await scanFolders(jpgFolder, '', 12, el))) return;

  // ── 场景 A：预设 ──────────────────────────────────────
  raw(`===== 场景 A：LUMEN RAW 预设 =====`);
  if (!(await clickCell('IMG_010', el))) return;
  pressKey('e');
  raw(`[${el()}] 已派发 'e'（进入调色）`);
  await sleep(1200);

  const presetSel = await waitFor(
    () => document.querySelector<HTMLSelectElement>('#tonal-preset'),
    45_000,
    1000,
  );
  raw(`[${el()}] 预设下拉 #tonal-preset = ${!!presetSel}`);
  if (!presetSel) {
    raw(`[${el()}] body 快照: ${document.body.innerText.replace(/\s+/g, ' ').slice(0, 600)}`);
    return;
  }

  // 等面板打开读回（getToneState → 新进程读 .lumen）落地再取基线：
  // 读回是异步 effect，若在它完成前读「套用前」，稍后读回的迟到值会被
  // 误判成 apply 的效果（run5 的假阳性链条之一）。
  await sleep(800);
  const before = readSliders();
  raw(`[${el()}] 套用前滑杆 = ${JSON.stringify(before)}`);

  const options = Array.from(presetSel.options).filter((o) => o.value !== '');
  raw(`[${el()}] 预设选项(${options.length}): ${options.map((o) => o.textContent).join(' / ')}`);
  if (!options.length) {
    raw(`[${el()}] FATAL: 预设下拉没有可选项`);
    return;
  }
  const pick = options[0];
  setControlValue(presetSel, pick.value);
  raw(`[${el()}] 已选预设 = ${pick.textContent}（value=${pick.value}）`);
  await sleep(700);

  const confirmBtn = await waitFor(() => findButton('套用并保存'), 10_000, 300);
  raw(`[${el()}] 「套用并保存」按钮 = ${!!confirmBtn}`);
  if (!confirmBtn) {
    const dlg = document.querySelector('[role="dialog"]');
    raw(`[${el()}] 对话框快照: ${(dlg?.textContent || '(无)').replace(/\s+/g, ' ').slice(0, 300)}`);
    return;
  }
  confirmBtn.click();
  raw(`[${el()}] 已点击「套用并保存」，等待 apply + save + getToneState 回填…`);

  let after = before;
  for (let i = 0; i < 30; i += 1) {
    await sleep(1000);
    after = readSliders();
    if (!sameSliders(before, after)) break;
  }
  raw(`[${el()}] 套用后滑杆 = ${JSON.stringify(after)}`);
  raw(`[${el()}] >>> 断言A1 滑杆读回变化 = ${!sameSliders(before, after)}`);
  // A2 独立轮询：apply 完整链路含两次 sidecar 进程（apply+save → getToneState
  // 读回），实测约 4s；A1 命中时刻不保证 toast 已入 DOM（run5 在 A1 后 35ms
  // 检查到 false 的教训）。等 toast 出现（与 A1 同窗，最多 10s）。
  const toastSeen = await waitFor(
    () => (/已应用预设/.test(document.body.innerText) ? true : null),
    10_000,
    200,
  );
  raw(`[${el()}] >>> 断言A2 「已应用预设」toast = ${!!toastSeen}`);
  // A3：用户 2026-10-15 报告的缺陷 —— 套用成功后下拉框应显示所选预设名，
  // 而不是复位到「选择预设…」。名字在 apply+getToneState resolve 后才写入，
  // 与 A2 同窗轮询（toast 出现时可能还差一拍）。
  const presetShown = await waitFor(
    () => (presetSel.value === pick.value ? presetSel.value : null),
    10_000,
    200,
  );
  raw(
    `[${el()}] >>> 断言A3 预设下拉显示已套用名 = ${presetShown === pick.value}（显示="${presetSel.value}"，期望="${pick.value}"）`,
  );
  raw(`[${el()}] 场景 A 结束`);

  // ── 场景 B：自动调色 ──────────────────────────────────
  raw(`===== 场景 B：自动调色 =====`);
  pressKey('Escape');
  await sleep(900);
  await dismissDirtyDialog(el); // Escape 关面板若触发未保存保护，这里放行
  if (!(await clickCell('IMG_011', el))) return;
  await dismissDirtyDialog(el); // 切图保护（防御性）
  // 只在面板未开时按 'e'，避免把已开的面板切关
  const panelOpen = !!document.querySelector('button[aria-label="智能自动调色"]');
  if (!panelOpen) {
    pressKey('e');
    raw(`[${el()}] 面板未开，已派发 'e'（IMG_011 进入调色）`);
  } else {
    raw(`[${el()}] 面板已开，跳过 'e'`);
  }
  await sleep(2500); // 等视口图加载完成（采样前提 complete && naturalWidth>0）

  const beforeAuto = readSliders();
  raw(`[${el()}] 自动前滑杆 = ${JSON.stringify(beforeAuto)}`);
  const autoBtn = document.querySelector<HTMLButtonElement>('button[aria-label="智能自动调色"]');
  raw(`[${el()}] 「自动」按钮 = ${!!autoBtn}`);
  autoBtn?.click();
  await sleep(4500); // 采样 + 若主图被污染则带 CORS 副本回退重载
  const afterAuto = readSliders();
  raw(`[${el()}] 自动后滑杆 = ${JSON.stringify(afterAuto)}`);
  raw(`[${el()}] >>> 断言B1 自动调色滑杆变化 = ${!sameSliders(beforeAuto, afterAuto)}`);
  raw(`[${el()}] 场景 B 结束`);
}

/** 视口主图：单图模式下 `alt` 就是 baseName（缩略图不带 alt）。 */
function viewportImg(baseName: string): HTMLImageElement | null {
  return document.querySelector<HTMLImageElement>(`img[alt="${baseName}"]`);
}

/** 从 inline transform 读当前缩放倍数（没有 transform 视为 1）。 */
function scaleOf(img: HTMLImageElement): number {
  const m = /scale\(([\d.]+)\)/.exec(img.style.transform || '');
  return m ? Number(m[1]) : 1;
}

/**
 * 「正在生成 1:1 细节」提示在不在 —— 按 `role="status"` 节点判定。
 *
 * 不能用 `body.innerText.includes(...)`：视口底栏的提示文字同样在 DOM 里，
 * 全局文本搜索会把「别处的字」当成「这条提示还在」。
 */
function detailLoadingVisible(): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="status"]')).some((n) =>
    (n.textContent || '').includes('正在生成 1:1 细节'),
  );
}

/**
 * 场景：RAW-only 1:1 细节（FR-05）。
 *
 * 为什么必须用**真实 ARW**：夹具里的 RAW 是「JPEG 字节 + .ARW 后缀」，
 * `photo.export` 解不出图，1:1 永远走不到 —— 那样测出来的「通过」毫无意义。
 *
 * 五段，每段都在验一件 jsdom 测不到的事：
 *   A. 首次 1:1：真耗时（≤10s 的出口标准）、换的是全分辨率图、`scale` 真的是
 *      `naturalWidth / offsetWidth`（jsdom 不布局，只能给这两个值打桩，
 *      打桩等于假设结论成立）；
 *   B. 再按 Z 回适应窗口；
 *   C1. **离开 1:1 之后按 Z 必须重新进 1:1**（issue #18 · PB-10）：滚轮是真
 *      窗口里唯一能把比例推离 1:1 的手势（双击本身就是 Z 同构的开关，拖拽
 *      在 1:1 时被夹紧、比例不变）。jsdom 里这条只能靠打桩，这里读的是真
 *      布局出来的 `offsetWidth`；
 *   C2. 切走再切回 → 重新请求走**缓存命中**（≤2s，而不是再等 6–8s）；
 *   D. 另一张上取消 → 提示消失、仍停在预览；再按 Z 能重新认领那次在飞的结果
 *      （不能静默失效，否则「取消」等于把 Z 键弄坏）。
 */
async function scenarioDetailOneToOne(
  jpgFolder: string,
  rawFolder: string,
  names: string,
  el: () => string,
) {
  if (!rawFolder) {
    raw(`[${el()}] FATAL: 未提供 VITE_E2E_RAW（需要含真实 ARW 的目录）`);
    return;
  }
  const [nameA, nameB] = names
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!nameA || !nameB) {
    raw(`[${el()}] FATAL: 未提供 VITE_E2E_NAMES（两张 RAW 的 baseName，逗号分隔）`);
    return;
  }

  await ensureLumenEnabled(el);
  // 12 张夹具 JPG + 3 张真实 RAW-only = 15 组；给下限，不绑死夹具数量
  if (!(await scanFolders(jpgFolder, rawFolder, 13, el))) return;

  // ── A. 首次 1:1 ───────────────────────────────────────
  raw('===== 场景 A：首次 1:1（真实 ARW）=====');
  if (!(await clickCell(nameA, el))) return;

  const imgA = await waitFor(
    () => {
      const img = viewportImg(nameA);
      return img && img.complete && img.naturalWidth > 0 ? img : null;
    },
    90_000,
    500,
  );
  raw(`[${el()}] 预览就绪 = ${!!imgA}（naturalWidth=${imgA?.naturalWidth ?? 0}）`);
  if (!imgA) {
    raw(`[${el()}] body 快照: ${document.body.innerText.replace(/\s+/g, ' ').slice(0, 400)}`);
    return;
  }
  const previewWidth = imgA.naturalWidth;
  raw(`[${el()}] >>> 断言D1 预览被硬顶在 1600 = ${previewWidth <= 1600}（${previewWidth}）`);
  raw(`[${el()}] >>> 断言D2 此时还是预览不是细节 = ${!/_detail_lumen/.test(imgA.src)}`);

  const tFirst = Date.now();
  pressKey('z');
  // 渲染提示只在 URL 还没落、且 hook 的 loading 为真时出现。缓存命中时
  // `lumen_detail_cmd` 100ms 内就返回（实测 101–109ms），提示根本来不及被
  // 采样到 —— 先轮询等它出现，再判 false，否则是拿「采样太粗」当「没提示」。
  const banner = await waitFor(
    () => (detailLoadingVisible() ? true : null),
    3_000,
    50,
  );
  raw(`[${el()}] >>> 断言D3 渲染中有明确提示 = ${!!banner}`);

  const detailA = await waitFor(
    () => {
      const img = viewportImg(nameA);
      return img && /_detail_lumen/.test(img.src) && img.complete && img.naturalWidth > 2000
        ? img
        : null;
    },
    90_000,
    200,
  );
  const firstMs = Date.now() - tFirst;
  raw(
    `[${el()}] 首次细节 ${firstMs}ms，naturalWidth=${detailA?.naturalWidth ?? 0}，src=${(detailA?.src || '').split('/').pop()}`,
  );
  raw(`[${el()}] >>> 断言D4 首次 ≤10s = ${!!detailA && firstMs <= 10_000}（${firstMs}ms）`);
  raw(
    `[${el()}] >>> 断言D5 换成了全分辨率图 = ${!!detailA && detailA.naturalWidth > previewWidth}`,
  );
  if (!detailA) {
    raw(`[${el()}] body 快照: ${document.body.innerText.replace(/\s+/g, ' ').slice(0, 400)}`);
    return;
  }

  // onLoad → zoom.oneToOne 在下一帧；留一拍再读
  await sleep(600);
  const shown = viewportImg(nameA);
  if (shown) {
    const expected = shown.naturalWidth / shown.offsetWidth;
    const actual = scaleOf(shown);
    raw(
      `[${el()}] 1:1 读数 scale=${actual.toFixed(3)} 期望=${expected.toFixed(3)}（natural=${shown.naturalWidth} offset=${shown.offsetWidth}）`,
    );
    raw(`[${el()}] >>> 断言D6 缩放就是真 1:1 = ${Math.abs(actual - expected) < 0.05}`);
  }

  // ── B. 再按 Z 回适应窗口 ──────────────────────────────
  raw('===== 场景 B：再按 Z 回适应窗口 =====');
  pressKey('z');
  await sleep(600);
  const backScale = shown ? scaleOf(shown) : -1;
  raw(
    `[${el()}] >>> 断言D7 回到适应窗口 = ${Math.abs(backScale - 1) < 0.01}（${backScale.toFixed(3)}）`,
  );

  // ── C1. 离开 1:1 → 再按 Z 仍要落回 1:1（PB-10）─────────
  raw('===== 场景 C1：滚轮离开 1:1 后再按 Z（PB-10）=====');
  const wheelHost = viewportImg(nameA)?.parentElement;
  if (wheelHost) {
    // deltaY<0 即放大一格。1:1 已经是 7.6 倍，再放大就到图片真实像素之外 ——
    // 比例必须真的变了，这一条才有意义。
    wheelHost.dispatchEvent(
      new WheelEvent('wheel', { deltaY: -100, clientX: 400, clientY: 300, bubbles: true }),
    );
  }
  await sleep(600);
  const afterWheel = viewportImg(nameA);
  const wheelScale = afterWheel ? scaleOf(afterWheel) : -1;
  const oneToOneScale = afterWheel ? afterWheel.naturalWidth / afterWheel.offsetWidth : -1;
  raw(`[${el()}] 滚一格后 scale=${wheelScale.toFixed(3)}（1:1 应为 ${oneToOneScale.toFixed(3)}）`);
  raw(`[${el()}] >>> 断言C-1 滚轮真的离开了 1:1 = ${Math.abs(wheelScale - oneToOneScale) > 0.5}`);

  pressKey('z');
  // 缓存已在场景 A 落盘，重新进入是命中路径，不需要再等 6–8s。
  await waitFor(
    () => {
      const img = viewportImg(nameA);
      return img && /_detail_lumen/.test(img.src) && img.complete ? img : null;
    },
    20_000,
    100,
  );
  await sleep(600);
  const reEntered = viewportImg(nameA);
  const reScale = reEntered ? scaleOf(reEntered) : -1;
  const reExpected = reEntered ? reEntered.naturalWidth / reEntered.offsetWidth : -1;
  raw(`[${el()}] 再按 Z 后 scale=${reScale.toFixed(3)} 期望=${reExpected.toFixed(3)}`);
  const reEnteredOk = reScale > 1 && Math.abs(reScale - reExpected) < 0.05;
  raw(`[${el()}] >>> 断言C-2 离开 1:1 后按 Z 重新进 1:1 = ${reEnteredOk}`);

  // ── C2. 切走再切回 → 缓存命中 ─────────────────────────
  raw('===== 场景 C2：切走再切回（缓存命中）=====');
  pressKey('d', 'KeyD');
  await sleep(1500);
  pressKey('a', 'KeyA');
  await sleep(1500);
  const backToA = viewportImg(nameA);
  raw(`[${el()}] 切回后已回到预览 = ${!!backToA && !/_detail_lumen/.test(backToA.src)}`);

  const tCache = Date.now();
  pressKey('z');
  const cachedA = await waitFor(
    () => {
      const img = viewportImg(nameA);
      return img && /_detail_lumen/.test(img.src) && img.complete ? img : null;
    },
    20_000,
    100,
  );
  const cacheMs = Date.now() - tCache;
  raw(`[${el()}] 缓存命中 ${cacheMs}ms`);
  raw(`[${el()}] >>> 断言D8 缓存命中 ≤2s = ${!!cachedA && cacheMs <= 2_000}（${cacheMs}ms）`);

  // ── D. 另一张上取消 → 再按 Z 重新认领 ─────────────────
  raw('===== 场景 D：取消与重新认领 =====');
  if (!(await clickCell(nameB, el))) return;
  const imgB = await waitFor(
    () => {
      const img = viewportImg(nameB);
      return img && img.complete && img.naturalWidth > 0 ? img : null;
    },
    90_000,
    500,
  );
  raw(`[${el()}] B 预览就绪 = ${!!imgB}（naturalWidth=${imgB?.naturalWidth ?? 0}）`);
  if (!imgB) return;

  pressKey('z');
  const bannerB = await waitFor(
    () => (detailLoadingVisible() ? true : null),
    3_000,
    50,
  );
  raw(`[${el()}] >>> 断言D9 B 上出现渲染提示 = ${!!bannerB}`);

  // 横幅里的「取消」按钮 —— 只在「正在生成」那条横幅里找，设置弹窗等别处也有「取消」
  const bannerNode = Array.from(document.querySelectorAll<HTMLElement>('[role="status"]')).find(
    (n) => (n.textContent || '').includes('正在生成 1:1 细节'),
  );
  const cancelBtn = bannerNode?.querySelector<HTMLButtonElement>('button') ?? null;
  raw(`[${el()}] 横幅上的「取消」按钮 = ${!!cancelBtn}`);
  cancelBtn?.click();

  // 先等 loading 真的落下，再要求横幅消失。原先直接等「横幅不在」，而
  // 100ms 快速轮询下点击后那一帧本就还没重渲染 —— 断言在 0ms 处就判真，
  // 什么都没验到（2026-11-02 两次连跑：点没点到都是 true）。
  const loadingGone = await waitFor(
    () => (detailLoadingVisible() ? null : true),
    5_000,
    50,
  );
  raw(`[${el()}] >>> 断言D10 取消后渲染中提示落下 = ${!!loadingGone}`);
  raw(
    `[${el()}] >>> 断言D11 取消不弹「渲染失败」 = ${!document.body.innerText.includes('细节渲染失败')}`,
  );
  raw(`[${el()}] >>> 断言D12 取消后仍停在预览 = ${!!imgB && !/_detail_lumen/.test(imgB.src)}`);

  // 反悔：同一张再按 Z。后端那次渲染还在飞，必须「重新认领」而不是静默无效。
  //
  // 计时从**这一下**开始，不包住上面被取消的那段：D14 问的是「重按之后有没有
  // 从头再渲一遍」，被取消的那次渲染本来就该算在等待里（真机实测它可能长达
  // 一分钟），把它算进窗口只会让这条断言量的是机器的快慢。
  const tB = Date.now();
  pressKey('z');
  // 认领后 3s 看一眼挂载源：分不清「认领没生效」与「认领了但落点没算出来」，
  // 下面两条无论怎么红都指不到原因（2026-11-02 实测就红在这里）。
  await sleep(3_000);
  const afterReclaim = viewportImg(nameB);
  raw(
    `[${el()}] 再按 Z 后 3s：${/_detail_lumen/.test(afterReclaim?.src ?? '') ? '已挂细节' : '仍是预览'}` +
      ` scale=${afterReclaim ? scaleOf(afterReclaim).toFixed(3) : '-'}`,
  );
  const reclaimedB = await waitFor(
    () => {
      const img = viewportImg(nameB);
      return img && /_detail_lumen/.test(img.src) && img.complete ? img : null;
    },
    60_000,
    200,
  );
  const reclaimMs = Date.now() - tB;
  raw(`[${el()}] 重按后到细节就绪 ${reclaimMs}ms（不含被取消的那段渲染）`);
  raw(`[${el()}] >>> 断言D13 取消后再按 Z 仍能出图 = ${!!reclaimedB}`);
  raw(
    `[${el()}] >>> 断言D14 重按后没有从头重渲（< 12s） = ${!!reclaimedB && reclaimMs < 12_000}（${reclaimMs}ms）`,
  );

  raw(`[${el()}] 场景 D 结束`);
}

/** 场景的附加素材/输出目录（缺省为空串，场景自行判断是否必需）。 */
export interface E2EScenarioOptions {
  /** RAW 原片目录；不填则只扫 JPG。 */
  raw?: string;
  /** 成片导出的目标目录（`render-export` 场景必填）。 */
  out?: string;
  /** 逗号分隔的 baseName 清单（`detail-1to1` 用它锁定两张真实 RAW）。 */
  names?: string;
}

/** 入口：由 main.tsx 在 dev 下从 Vite 的 `/__e2e_scenario` 取到配置后调用。 */
export async function runE2E(
  scenario: string,
  jpgFolder: string,
  opts: E2EScenarioOptions = {},
) {
  if (!scenario) return;

  const t0 = Date.now();
  const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  raw(`=== e2e start: scenario=${scenario} jpg=${jpgFolder} ===`);

  const mounted = await waitFor(
    () => ((document.getElementById('root')?.children.length ?? 0) > 0 ? true : null),
    60_000,
    300,
  );
  raw(`[${el()}] 应用挂载 = ${!!mounted}`);
  if (!mounted) {
    raw(`[${el()}] FATAL: 应用未挂载`);
    return;
  }
  // 等主界面稳定（设置按钮出现）
  const ready = await waitFor(() => findButton('设置'), 60_000, 500);
  raw(`[${el()}] 主界面就绪 = ${!!ready}`);
  if (!ready) {
    const labels = Array.from(document.querySelectorAll('button')).map((b) =>
      (
        (b.textContent || '').trim() ||
        b.getAttribute('aria-label') ||
        b.getAttribute('title') ||
        '(无标签)'
      )
        .replace(/\s+/g, ' ')
        .slice(0, 24),
    );
    raw(`[${el()}] FATAL: 主界面未就绪；按钮清单(${labels.length}): ${JSON.stringify(labels)}`);
    raw(`[${el()}] body 快照: ${document.body.innerText.replace(/\s+/g, ' ').slice(0, 400)}`);
    return;
  }

  try {
    if (scenario === 'load-photos') {
      await scenarioLoadPhotos(jpgFolder, opts.raw || '', el);
    } else if (scenario === 'lumen-preset') {
      await scenarioLumenPreset(jpgFolder, el);
    } else if (scenario === 'render-export') {
      await scenarioRenderExport(jpgFolder, opts.raw || '', opts.out || '', el);
    } else if (scenario === 'detail-1to1') {
      await scenarioDetailOneToOne(jpgFolder, opts.raw || '', opts.names || '', el);
    } else if (scenario === 'ui-contract') {
      await scenarioUiContract(jpgFolder, el);
    } else {
      raw(`[${el()}] 未知场景: ${scenario}`);
    }
  } catch (err) {
    raw(`[${el()}] 场景异常: ${err instanceof Error ? err.message : String(err)}`);
  }

  raw(`=== e2e done (${el()}) ===`);
}
