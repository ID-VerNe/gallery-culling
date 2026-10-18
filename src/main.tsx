import { StrictMode } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    {/* 渲染期抛错时兜底：白屏必须有「重新加载」出口，而不是无提示空白窗口。 */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

/**
 * dev-only：e2e 自测入口。
 *
 * 本机 WebView2 的 CDP 端口只服务第一个请求，Playwright 连不上（见
 * `.plan/lumen-preset-autotone-console-diagnosis-2026-10-15.md`），
 * 因此自测改为应用内驱动。
 *
 * 场景配置从 Vite dev server 的 `/__e2e_scenario`（Node 侧读 process.env）
 * 拉取，而不是 `import.meta.env`——启动链路是
 * bash → npm → tauri CLI → npm → vite，环境变量在前端注入层不够可靠。
 * 生产构建时 `import.meta.env.DEV` 为 false，整块连同动态 import 一并被消除。
 */
if (import.meta.env.DEV) {
  void (async () => {
    try {
      const res = await fetch('/__e2e_scenario');
      const cfg = (await res.json()) as {
        scenario?: string;
        jpg?: string;
        raw?: string;
        out?: string;
        names?: string;
      };
      // 启动诊断：无论是否要跑场景，都上报一次，便于外部脚本确认链路通了。
      void fetch('/__e2e_log', {
        method: 'POST',
        body: `[boot-v2] DEV=${import.meta.env.DEV} scenario=${cfg.scenario || '(unset)'} jpg=${cfg.jpg || '(unset)'}`,
      });
      if (!cfg.scenario) return;
      const mod = await import('./devtools/e2eRunner');
      await mod.runE2E(cfg.scenario, cfg.jpg || '', {
        raw: cfg.raw || '',
        out: cfg.out || '',
        names: cfg.names || '',
      });
    } catch {
      // dev-only 便利功能，不可用时静默跳过，不影响应用本身
    }
  })();
}
