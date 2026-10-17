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
 *   - `lumen-preset`：LUMEN RAW 预设 + 自动调色（用 `VITE_E2E_JPG`）
 *   - `render-export`：调色成片导出（`VITE_E2E_JPG` + `VITE_E2E_RAW` + `VITE_E2E_OUT`）
 *
 * 触发：`npm run e2e:render` / `npm run e2e:preset`（见 `e2e/run-inapp.mjs`），
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

/** 派发键盘事件到 window（应用在 window 上监听 keydown）。 */
function pressKey(key: string) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
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

  // ── 范围 + 目标 ────────────────────────────────────────
  // 默认档「已保留或已打星」在夹具上只会命中 4 组；切到「全部非淘汰照片」
  // 才能把「配对组（走假 RAW → 必失败）」和「纯 JPG 组（可能成功）」同时纳入，
  // 一次运行覆盖成功与失败两条路径。
  const allRadio = dlg.querySelector<HTMLInputElement>('#export-filter-all');
  raw(`[${el()}] 「全部非淘汰照片」单选框 = ${!!allRadio}`);
  if (!allRadio) return;
  allRadio.click();
  await sleep(500);

  const targetInput = dlg.querySelector<HTMLInputElement>('#export-target-folder');
  raw(`[${el()}] 目标目录输入框 = ${!!targetInput}`);
  if (!targetInput) return;
  setControlValue(targetInput, outFolder);
  await sleep(700);

  const m = dlg.innerText.match(/预计生成[：:]\s*(\d+)/);
  raw(`[${el()}] 预计生成候选数 = ${m ? m[1] : '(未解析到)'}`);

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

/** 场景的附加素材/输出目录（缺省为空串，场景自行判断是否必需）。 */
export interface E2EScenarioOptions {
  /** RAW 原片目录；不填则只扫 JPG。 */
  raw?: string;
  /** 成片导出的目标目录（`render-export` 场景必填）。 */
  out?: string;
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
    if (scenario === 'lumen-preset') {
      await scenarioLumenPreset(jpgFolder, el);
    } else if (scenario === 'render-export') {
      await scenarioRenderExport(jpgFolder, opts.raw || '', opts.out || '', el);
    } else {
      raw(`[${el()}] 未知场景: ${scenario}`);
    }
  } catch (err) {
    raw(`[${el()}] 场景异常: ${err instanceof Error ? err.message : String(err)}`);
  }

  raw(`=== e2e done (${el()}) ===`);
}
