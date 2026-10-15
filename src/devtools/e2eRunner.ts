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
 * 触发：`VITE_E2E_SCENARIO=<场景> VITE_E2E_JPG=<绝对路径> npm run tauri dev`
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

/** 场景：LUMEN RAW 预设（问题一）+ 自动调色（问题二）。 */
async function scenarioLumenPreset(jpgFolder: string, el: () => string) {
  // ── 前置：开启 LUMEN 引擎 ─────────────────────────────
  await ensureLumenEnabled(el);

  // ── 扫描 ──────────────────────────────────────────────
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
    return;
  }
  setControlValue(jpgInput, jpgFolder);
  if (rawInput) setControlValue(rawInput, '');
  await sleep(400);
  raw(`[${el()}] 已填路径 jpg="${jpgInput.value}"`);

  const scanBtn = findButton('扫描照片目录');
  raw(`[${el()}] 「扫描照片目录」按钮 = ${!!scanBtn}`);
  scanBtn?.click();

  // 扫描完成的**可靠**信号：宫格渲染出全部单元格（夹具 12 张）**且**扫描按钮
  // 恢复可用。不能只查底栏计数正则 —— 它在扫描**进行中**就命中「0 / 12」，
  // 12ms 即假阳性（run5 实测）；此时 onScanned（setGroups + 会话恢复）尚未执行，
  // 随后到达的恢复会翻转用户刚点的选中（Bug B 的触发窗口）。
  // 按钮 disabled ↔ isLoading || scanTask.isRunning，恢复发生在 onScanned 之后，
  // 因此「单元格齐 + 按钮可用」= 扫描与会话恢复都已落地。
  const counted = await waitFor(
    () => {
      const n = document.querySelectorAll('[role="option"]').length;
      return n >= 12 && scanBtn && !scanBtn.disabled ? n : null;
    },
    120_000,
    400,
  );
  raw(`[${el()}] 扫描完成（单元格齐 ${counted ?? 0} + 按钮恢复）= ${!!counted}`);
  if (!counted) {
    raw(`[${el()}] body 快照: ${document.body.innerText.replace(/\s+/g, ' ').slice(0, 500)}`);
    return;
  }

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

/** 入口：由 main.tsx 在 dev 下从 Vite 的 `/__e2e_scenario` 取到配置后调用。 */
export async function runE2E(scenario: string, jpgFolder: string) {
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
    } else {
      raw(`[${el()}] 未知场景: ${scenario}`);
    }
  } catch (err) {
    raw(`[${el()}] 场景异常: ${err instanceof Error ? err.message : String(err)}`);
  }

  raw(`=== e2e done (${el()}) ===`);
}
