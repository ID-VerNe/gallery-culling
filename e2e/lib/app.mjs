/**
 * 真应用生命周期管理：带 WebView2 远程调试启动 / 就绪探测 / 优雅关闭 / 重启。
 *
 * 为什么要远程调试：Tauri 的 WebView2 不把 DOM 暴露给 Windows UI Automation，
 * 所以 e2e 走 CDP（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port`）
 * 用 Playwright 连真实窗口 —— 连的是真窗口 + 真 Rust 后端，不是 mock。
 */
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, '..', '..');
const IS_WIN = process.platform === 'win32';

export const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9222);
export const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

/**
 * 给 WebView2 追加浏览器参数时的**唯一正确写法**。
 *
 * `src-tauri/src/main.rs` 只在 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` **未设置**
 * 时才写入 `--in-process-gpu`（GPU 子进程崩溃 workaround）。任何地方直接 set
 * 这个变量都会把它抹掉 —— 于是 GPU 子进程在 STATIC_INIT 连崩 9 次、Chromium
 * 判定 GPU 不可用、浏览器进程自杀，表现就是白屏 +
 * `msedgewebview2 has stopped working` / `Error launching CrashSender.exe`
 * （2026-10-15 的完整排查见
 * `.plan/lumen-preset-autotone-console-diagnosis-2026-10-15.md` §5）。
 *
 * 所以：**要加参数就必须显式带上 `--in-process-gpu`**，别指望 main.rs 兜底。
 * 2026-10-17 就是因为漏了这一步，跑 e2e 时把用户上次修好的崩溃又复现了一遍。
 */
export function webviewArgs(...extra) {
  return ['--in-process-gpu', ...extra.filter(Boolean)].join(' ');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 跑一条系统命令。
 *
 * 关键点：Windows 上必须用 cmd.exe 当 shell，不能用 Git bash。
 * Git bash（MSYS）会把 `/F` `/T` `/PID` 这类 Windows 开关当成路径去改写
 * （`/F` -> `F:\`），于是 taskkill 收到一堆垃圾参数、静默失败 ——
 * 这正是之前「重启时旧 vite 没被收掉、新 vite 抢不到 1420」的根因。
 */
const SHELL = IS_WIN ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
function sh(cmd, opts = {}) {
  return execSync(cmd, { shell: SHELL, encoding: 'utf8', stdio: 'pipe', ...opts });
}

/** 本进程启动的 dev 根进程（npm run tauri dev），用于整棵树回收。 */
let devRootPid = null;

function killTree(pid) {
  if (!pid) return;
  try {
    // /T 连子进程一起收：npm -> node(vite) -> cargo -> gallery-culling.exe
    sh(`taskkill /F /T /PID ${pid} >nul 2>&1`);
  } catch {
    /* 进程已经没了就会非零退出，属正常 */
  }
}

/**
 * 杀掉占用某个端口的进程。
 *
 * 为什么不能只靠 taskkill /T：npm 在 Windows 上要经好几层壳
 * （npm.cmd -> node -> cmd -> node/vite），/T 有时追不到 vite，
 * 结果重启时新 vite 抢不到 1420 直接退出（报 "beforeDevCommand terminated"）。
 * 直接按端口找属主最可靠。
 */
function killPortOwner(port) {
  if (!IS_WIN) {
    try {
      sh(`lsof -ti tcp:${port} | xargs -r kill -9`);
    } catch {
      /* noop */
    }
    return;
  }
  let out;
  try {
    // findstr 没命中会返回 1，execSync 抛错，属正常（说明端口没人占）
    out = sh(`netstat -ano -p tcp | findstr LISTENING | findstr :${port}`);
  } catch {
    return;
  }
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(/(\d+)\s*$/);
    if (m && m[1] !== '0') pids.add(m[1]);
  }
  for (const pid of pids) killTree(pid);
}

export function killApp() {
  if (IS_WIN) {
    // 先收整棵 dev 树：只杀应用/cargo 会把 npm 与 vite 留下，
    // 下次 launch 会再起一份 vite 抢 1420 端口（表现为 502）。
    killTree(devRootPid);
    devRootPid = null;
    try {
      sh('taskkill /F /T /IM gallery-culling.exe >nul 2>&1');
    } catch {
      /* noop */
    }
    try {
      sh('taskkill /F /T /IM cargo.exe >nul 2>&1');
    } catch {
      /* noop */
    }
    // 兜底：按端口收属主，防止 /T 漏掉藏在 npm 壳里的 vite
    killPortOwner(CDP_PORT);
    killPortOwner(1420);
  } else {
    try {
      sh('pkill -f gallery-culling');
    } catch {
      /* noop */
    }
    killPortOwner(CDP_PORT);
    killPortOwner(1420);
  }
}

/** 只回收 dev 进程树，不动应用窗口（重启前用）。 */
export function killDevTree() {
  killTree(devRootPid);
  devRootPid = null;
  killPortOwner(CDP_PORT);
  killPortOwner(1420);
}

export function isAppRunning() {
  if (!IS_WIN) {
    try {
      sh("pgrep -f gallery-culling >/dev/null");
      return true;
    } catch {
      return false;
    }
  }
  try {
    sh('tasklist /FI "IMAGENAME eq gallery-culling.exe" /NH | findstr /I gallery-culling');
    return true;
  } catch {
    return false;
  }
}

/** CDP 端点是否已就绪（= WebView2 已起来并加载了页面）。 */
export async function cdpReady(timeoutMs = 5000) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(CDP_URL + '/json/version', { signal: ac.signal });
    clearTimeout(t);
    if (!res.ok) return false;
    const j = await res.json();
    return Boolean(j.webSocketDebuggerUrl);
  } catch {
    return false;
  }
}

/**
 * 把 dev 进程树拉起来并把输出落盘（**不等就绪**）。
 *
 * 两条路共用：`launchApp`（等 CDP 页面）与应用内驱动编排器（等日志）。
 * 走过两条弯路，记在这里免得再踩：
 *   - stdio 传 fd：Windows + detached 下句柄传不进去，日志恒为 0 字节；
 *   - .cmd shim + 参数：cmd.exe 会把整串当命令行重新解析，转义极易出错。
 * 编排器本来就全程持有这个子进程，所以不需要 detached（也就不需要 shim）。
 */
function spawnDevProcess({ logFile, extraEnv = {} }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  try {
    fs.writeFileSync(logFile, '', 'utf8');
  } catch {
    /* 截断失败不该中断整个编排，旧内容保留即可 */
  }

  const child = spawn(
    IS_WIN ? 'cmd.exe' : 'sh',
    IS_WIN ? ['/c', 'npm run tauri dev'] : ['-c', 'npm run tauri dev'],
    {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  const appendLog = (d) => {
    try {
      fs.appendFileSync(logFile, d);
    } catch {
      /* 日志写失败不该影响测试 */
    }
  };
  child.stdout?.on('data', appendLog);
  child.stderr?.on('data', appendLog);
  devRootPid = child.pid;
  return child;
}

/**
 * 启动 dev 进程树但**不等 CDP 就绪**（应用内驱动场景用）。
 *
 * 为什么需要这条独立入口：本机 WebView2 的 CDP 端口只服务第一个请求，
 * 第二个请求（`/json/list`）就永久卡死，于是 `launchApp` 的 `appPageReady()`
 * 永远为假、白等到超时（详见
 * `.plan/lumen-preset-autotone-console-diagnosis-2026-10-15.md`）。
 * 应用内驱动的就绪信号是 `e2e/.tmp/e2e-app.log` 里的 `[boot-v2]` 行，
 * 与 CDP 无关 —— 所以这里只把进程拉起来，就绪判断交给日志。
 */
export async function spawnDevTree({
  logFile = path.join(PROJECT_ROOT, 'e2e', '.tmp', 'tauri-dev.log'),
  extraEnv = {},
} = {}) {
  killApp();
  // 等旧 WebView2 真正退出：端口还占着就 spawn，新进程会连到**旧实例**，
  // 于是「重启」读到的是重启前的状态 —— 这是上一版 07-session 假绿/假红的主因。
  if (!(await waitPortFree(60_000))) {
    console.warn('  [warn] 端口未释放干净，仍继续启动（可能读到旧实例）');
  }
  return spawnDevProcess({ logFile, extraEnv });
}

/**
 * 轮询日志文件直到 `test(content)` 为真。
 *
 * 用「读全文 + 正则」而不是 tail：单次运行的日志只有几十行，全文匹配不会
 * 漏掉两次轮询之间出现又消失的行。超时返回 `null`，由调用方决定怎么报错。
 */
export async function waitForLog(
  logFile,
  test,
  { timeoutMs = 15 * 60_000, intervalMs = 1000 } = {},
) {
  const t0 = Date.now();
  for (;;) {
    await sleep(intervalMs);
    let content = '';
    try {
      content = fs.readFileSync(logFile, 'utf8');
    } catch {
      content = '';
    }
    if (content && test(content)) {
      return { content, elapsedMs: Date.now() - t0 };
    }
    if (Date.now() - t0 > timeoutMs) return null;
  }
}

/**
 * 启动应用并等到「CDP 就绪 + 页面已渲染出应用根节点」。
 * 首次/改动 Rust 后要重新编译，给足超时。
 *
 * 注意：本机 WebView2 上这条路**走不通**（CDP 只服务第一个请求，
 * `appPageReady()` 永远为假）。保留它只为在 CDP 正常的机器上仍可用；
 * 本机请用 `spawnDevTree` + `waitForLog`。
 */
export async function launchApp({
  logFile = path.join(PROJECT_ROOT, 'e2e', '.tmp', 'tauri-dev.log'),
  timeoutMs = 15 * 60_000,
} = {}) {
  const child = await spawnDevTree({
    logFile,
    extraEnv: {
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: webviewArgs(`--remote-debugging-port=${CDP_PORT}`),
    },
  });

  const t0 = Date.now();
  let lastLen = 0;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(1500);
    const ready = await cdpReady(3000);
    // 端口起来后还要等**应用页面**真的挂上（CDP 先于 React 就绪）
    if (ready && (await appPageReady())) {
      // 再给前端一点时间完成首屏渲染与设置回填
      await sleep(2500);
      return { child, logFile, bootMs: Date.now() - t0 };
    }
    try {
      const size = fs.statSync(logFile).size;
      if (size !== lastLen) {
        lastLen = size;
        const tail = fs.readFileSync(logFile, 'utf8').slice(-2000);
        const m = [...tail.matchAll(/error[^\n]*/gi)].map((x) => x[0]);
        if (m.length) console.error('  [tauri dev] ' + m[m.length - 1].slice(0, 220));
      }
    } catch {
      /* noop */
    }
  }
  let tail = '';
  try {
    tail = fs.readFileSync(logFile, 'utf8').slice(-3000);
  } catch {
    /* noop */
  }
  throw new Error(
    `应用启动超时（${Math.round(timeoutMs / 1000)}s）。` +
      (tail ? `
--- ${logFile} 尾部 ---
${tail}` : `
日志为空：${logFile}`),
  );
}

/** 端口是否已无人应答（cdp 9222 与 vite 1420 都要等）。 */
async function waitPortFree(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!(await cdpReady(1200)) && !(await viteReady(1200))) return true;
    await sleep(500);
  }
  return false;
}

/** vite dev server 是否还在应答。 */
async function viteReady(timeoutMs) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch('http://127.0.0.1:1420/', { signal: ac.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

/** `/json/list` 的异常只报一次（每 1.5s 轮询一次，重复打印会淹掉日志）。 */
let appPageDiagOnce = false;

/**
 * 应用页面 target 是否已出现（url 指到 vite dev server）。
 *
 * 本机 WebView2 的 CDP 端口只服务第一个请求，这里通常永远拿不到结果。
 * 首次失败时把实际 target 列表打出来 —— 免得下次又在「CDP 通了但页面
 * 不就绪」上从头排查一遍（上一轮就为此白等了 900s）。
 */
async function appPageReady() {
  try {
    const list = await (await fetch(`${CDP_URL}/json/list`)).json();
    const targets = Array.isArray(list) ? list : [];
    const hit = targets.some(
      (t) => t && t.type === 'page' && typeof t.url === 'string' && t.url.includes('1420'),
    );
    if (!hit && !appPageDiagOnce) {
      appPageDiagOnce = true;
      const brief = targets
        .map((t) => `${(t && t.type) || '?'}:${String((t && t.url) || '').slice(0, 60)}`)
        .join(' | ');
      console.warn(`  [cdp] 未匹配到应用页面；targets(${targets.length})=${brief || '空'}`);
    }
    return hit;
  } catch (e) {
    if (!appPageDiagOnce) {
      appPageDiagOnce = true;
      console.warn(`  [cdp] /json/list 失败：${e && e.message}`);
    }
    return false;
  }
}

/** 优雅关闭（Tauri onCloseRequested -> flush session -> destroy）。 */
export async function closeAppGracefully(timeoutMs = 30_000) {
  if (!isAppRunning()) return true;
  if (IS_WIN) {
    const ps = path.join(path.dirname(fileURLToPath(import.meta.url)), 'close-app.ps1');
    try {
      sh(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps}"`);
    } catch {
      killApp();
    }
  } else {
    killApp();
  }
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!isAppRunning()) return true;
    await sleep(700);
  }
  killApp();
  await sleep(1000);
  return !isAppRunning();
}

/** 重启（会话恢复套件用）。 */
export async function restartApp(opts) {
  await closeAppGracefully();
  // 关窗后 npm/vite 仍活着，必须整棵回收，否则重启会起第二个 vite 抢端口
  killDevTree();
  await sleep(1500);
  return launchApp(opts);
}
