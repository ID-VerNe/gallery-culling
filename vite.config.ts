import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const host = process.env.TAURI_DEV_HOST;

/**
 * dev-only：前端错误捕获 + 请求日志。
 *
 * 白屏排查用：在 `</head>` 前注入最小内联脚本（先于所有模块执行），
 * 把 window 上的 error / unhandledrejection 直接 POST 到日志端点，
 * 这样即使 React 没起来，也能拿到第一手报错。
 */
const e2eErrorTrap = (): Plugin => ({
  name: 'e2e-error-trap',
  apply: 'serve',
  transformIndexHtml(html) {
    const trap = `<script>
(function () {
  var post = function (m) { try { fetch('/__e2e_log', { method: 'POST', body: m }); } catch (e) {} };
  window.addEventListener('error', function (e) {
    post('[error] ' + (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || '') + ':' + (e.colno || '') + (e.error && e.error.stack ? '\\n' + e.error.stack : ''));
  });
  window.addEventListener('unhandledrejection', function (e) {
    post('[rejection] ' + String(e.reason) + (e.reason && e.reason.stack ? '\\n' + e.reason.stack : ''));
  });
  // console.warn / console.error 落盘：问题二（canvas 污染 SecurityError）与
  // 后端失败细节大多只出现在 console 里，不捕获就没有直接证据。
  ['warn', 'error'].forEach(function (level) {
    var orig = console[level];
    console[level] = function () {
      try {
        var parts = Array.prototype.slice.call(arguments).map(function (a) {
          if (a instanceof Error) return a.message;
          if (a && typeof a === 'object') { try { return JSON.stringify(a); } catch (e2) { return String(a); } }
          return String(a);
        });
        post('[console.' + level + '] ' + parts.join(' '));
      } catch (e3) {}
      return orig.apply(console, arguments);
    };
  });
  post('[html] inline trap installed, readyState=' + document.readyState);
  window.addEventListener('DOMContentLoaded', function () { post('[html] DOMContentLoaded'); });
  window.addEventListener('load', function () { post('[html] window load'); });
})();
</script>`;
    return html.replace('</head>', `${trap}\n  </head>`);
  },
});

/**
 * dev-only：e2e 自测日志端点。
 *
 * 背景：本机 WebView2 的 `--remote-debugging-port` 只服务第一个请求
 * （详见 `.plan/lumen-preset-autotone-console-diagnosis-2026-10-15.md`），
 * Playwright `connectOverCDP` 必然超时。因此自测改为「应用内执行场景 +
 * 同源 POST 落盘」：前端把每步日志 POST 到这里，由 Vite（Node 侧）写文件，
 * 外部脚本读 `e2e/.tmp/e2e-app.log` 做断言。
 *
 * 仅在 `vite dev` 生效（apply: 'serve'），不进生产构建。
 */
const e2eLogEndpoint = (): Plugin => ({
  name: 'e2e-log-endpoint',
  apply: 'serve',
  configureServer(server) {
    // 诊断：记录进入 dev server 的请求（过滤高频依赖与 HMR 内部请求）。
    server.middlewares.use((req, _res, next) => {
      const url = req.url || '';
      const noisy =
        url.startsWith('/node_modules/') ||
        url.startsWith('/@fs/') ||
        url.endsWith('.css');
      if (!noisy) {
        console.log(`[req] ${new Date().toISOString().slice(11, 23)} ${req.method} ${url}`);
      }
      next();
    });

    // 场景配置端点：从 Node 侧（process.env）读，避免依赖前端 import.meta.env 注入。
    //
    // 四个字段而不是一个 JSON blob：启动命令里逐个 env 传参最不容易出错，
    // 且缺省为空串（场景代码据此判断「这条素材没配」而不是收到 undefined）。
    server.middlewares.use('/__e2e_scenario', (_req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          scenario: process.env.VITE_E2E_SCENARIO || '',
          jpg: process.env.VITE_E2E_JPG || '',
          raw: process.env.VITE_E2E_RAW || '',
          out: process.env.VITE_E2E_OUT || '',
        }),
      );
    });

    server.middlewares.use('/__e2e_log', (req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          const dir = path.resolve(process.cwd(), 'e2e/.tmp');
          fs.mkdirSync(dir, { recursive: true });
          fs.appendFileSync(path.join(dir, 'e2e-app.log'), body + '\n');
        } catch {
          // 日志写入失败不应影响应用运行
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('ok');
      });
    });

    console.log(
      `[e2e-endpoint] 就绪 | VITE_E2E_SCENARIO=${process.env.VITE_E2E_SCENARIO || '(未设置)'} | VITE_E2E_JPG=${process.env.VITE_E2E_JPG || '(未设置)'} | VITE_E2E_RAW=${process.env.VITE_E2E_RAW || '(未设置)'} | VITE_E2E_OUT=${process.env.VITE_E2E_OUT || '(未设置)'}`,
    );
  },
});

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), e2eErrorTrap(), e2eLogEndpoint()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // 必须显式绑 127.0.0.1：本机 WebView2（155.0.4283.45）解析 localhost 走 IPv4，
    // 而 Node 用 'localhost' 绑定时只绑 [::1]（IPv6）→ WebView2 连接被拒 → 白屏。
    // 实测证据见 .plan/lumen-preset-autotone-console-diagnosis-2026-10-15.md 白屏一节。
    host: host || '127.0.0.1',
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: process.env.TAURI_ENV_PLATFORM == 'windows' ? 'chrome105' : 'safari13',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
