# 真窗口 E2E（`e2e/`）

连**真实 Tauri 窗口 + 真实 Rust 后端**跑端到端回归，不是 mock。

与 `src/test/`（vitest）的分工：

| | vitest（`e2e:unit`） | 本目录（真窗口） |
|---|---|---|
| 对象 | 组件 / hook 逻辑 | 真窗口 + 真后端 + 真磁盘 |
| IPC | mock 掉 | 真发 |
| 速度 | 秒级 | 分钟级 |
| 能抓到 | 状态机、渲染分支 | XMP 落盘、扫描配对、成片导出、会话持久化 |

## 跑法

```bash
npm run e2e:unit      # 前端单测（vitest）
npm run e2e:rust      # Rust 单测（cargo test --lib）
npm run e2e:render    # 真窗口：调色成片导出
npm run e2e:preset    # 真窗口：LUMEN 预设 + 自动调色
npm run e2e           # 三档串起来（unit + rust + render），全绿才算过
```

真窗口用例的参数：

```bash
node e2e/run-inapp.mjs --scenario=render-export
node e2e/run-inapp.mjs --scenario=lumen-preset
node e2e/run-inapp.mjs --scenario=render-export --timeout=600000
```

退出码：`0` 全绿 / `1` 有用例失败 / `2` 启动或超时。

## 它自己管生命周期

`e2e:render` 一条命令做完：

1. **重建素材** —— 每次清空 `e2e/.tmp/fixtures/` 重新生成（测试会就地写 rating/tone/export，不清就会互相污染）；
2. **启动应用** —— 起 `tauri dev`，就绪信号是 `e2e/.tmp/e2e-app.log` 里出现场景日志（不是 CDP，见下节）；
3. **等场景跑完** —— 应用内执行场景，日志同源落盘；
4. **断言** —— 读日志断言 UI 表现，读文件系统断言落盘与清单；
5. **关闭应用** —— 优雅关窗（触发会话落盘）后回收整棵 dev 进程树。

首次或改过 Rust 要重新编译，启动约 30–90s；之后整轮约 2–4 分钟。

## 为什么不走 CDP

Tauri 的 WebView2 不把 DOM 暴露给 Windows UI Automation，所以界面断言本来只能靠
`--remote-debugging-port` + Playwright `connectOverCDP()`。

**但本机走不通**：WebView2 的调试端口**只服务第一个 HTTP 请求**，第二个请求
（`/json/list`）就永久卡死，`connectOverCDP` 必然超时。实测 Edge 同版本内核正常，
是 WebView2 自身的问题（详见 `.plan/lumen-preset-autotone-console-diagnosis-2026-10-15.md`）。

因此真窗口用例改为**应用内驱动**：

1. `src/devtools/e2eRunner.ts` 在应用内操作真实 DOM（点击 / 键盘 / 受控组件原生
   setter），走完整 前端 → Tauri IPC → Rust → lumen-cli sidecar 链路；
2. 每步日志同源 `POST /__e2e_log`，由 Vite 中间件落盘到 `e2e/.tmp/e2e-app.log`；
3. `e2e/run-inapp.mjs` 读日志断言 UI 部分，并**直接读文件系统**断言落盘与清单
   （浏览器里读不到目录，账实对账必须在外侧做）。

`e2e/run.mjs` + `suites/01-08` 是旧的 Playwright 路线，本机只会白等到超时，
保留只为在 CDP 正常的机器上仍可用。

## 目录

```
e2e/
  run-inapp.mjs           应用内驱动编排器（真窗口用例走这条）
  run.mjs                 旧 Playwright 编排器（本机不可用）
  lib/
    app.mjs               应用生命周期：启停 / 端口回收 / 日志等待
    harness.mjs           CDP 连接、弹窗清理、底栏读取、断言与报告（旧路线用）
    close-app.ps1         CloseMainWindow（触发 onCloseRequested）
  fixtures/
    generate.mjs          确定性素材 + EXPECTED 期望态表
  suites/                 旧 Playwright 套件（01-08）
  .tmp/                   运行时产物（素材 / 日志），已 gitignore
```

## 期望值只有一份

`fixtures/generate.mjs` 导出 `EXPECTED` 表（每张素材的星级/旗标真值），
套件从它**推导**断言，而不是在校验里另抄一份数字。改素材只需改这一处。

## 素材说明

- JPG：内嵌的 480×360 真 JPEG（base64）。尺寸是刻意的 —— 缩略图管线要走
  「取内嵌预览 → 否则按宽度缩放」，用 64×48 的迷你图会让缩放路径失去意义。
- XMP：7 个真 sidecar，覆盖 pick / reject（`Rating=-1` 与 `Label=Red` 两种约定）/
  普通星级 / 带 tone / `Label=None` 边界。
- RAW：**合成**（JPEG 字节 + `.ARW` 扩展名）。e2e 关心的是**配对与占位规则**
  （按扩展名/词干分组、C2 的 RAW-only 无预览），真解码 NEF 需要 LUMEN sidecar，
  那是另一个 opt-in 套件，不在本目录。

## 已知坑（都踩过，记下来）

- **绝对不要裸传 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`。** `src-tauri/src/main.rs`
  只在变量**未设置**时才写 `--in-process-gpu`（GPU 子进程崩溃 workaround）。
  任何地方直接 set 这个变量都会把它抹掉 → GPU 子进程 9 连崩 → 白屏 +
  `msedgewebview2 has stopped working` / `Error launching CrashSender.exe`。
  要加参数请用 `lib/app.mjs` 的 `webviewArgs()`，它显式带上 `--in-process-gpu`。
  应用内驱动**完全不需要** CDP，所以根本别传。
- **CDP 调试端口只服务第一个请求。** 别拿 `cdpReady()` + `appPageReady()` 当就绪
  信号 —— 本机第二个请求（`/json/list`）就卡死，只会白等到超时。应用内驱动的
  就绪信号是 `e2e-app.log` 里的 `[boot-v2]` / `=== e2e done`。
- **Windows 上不要用 Git bash 当 shell。** MSYS 会把 `/F` `/T` `/PID` 这类
  Windows 开关当路径改写（`/F` → `F:\`），`taskkill` 静默失败。
  `lib/app.mjs` 用 `cmd.exe`（`process.env.ComSpec`）。
- **不要靠 `taskkill /T` 收 vite。** npm 在 Windows 上要经好几层壳，
  `/T` 有时追不到 vite，重启时新 vite 抢不到 1420 就退出（报
  `beforeDevCommand terminated`）。`killPortOwner()` 按端口找属主兜底。
- **`cdpReady` 会读到旧实例。** 旧 WebView2 还占着 9222 时直接 spawn，
  新进程会连到旧实例，「重启」读到的是重启前的状态（假绿/假红）。
  启动前必须等端口真正释放。
- **底栏读取要一次 `evaluate` 取完。** 扫描/排序重渲染会让元素句柄失效，
  拿句柄再逐个 `innerText` 会超时。
- **缩略图是异步的。** 首轮还要现生成，必须 `waitForFunction` 等解码完成，
  固定 `sleep` 会 flaky。
- **成片导出的 e2e 不能断言「渲出来几张」。** 夹具里走 RAW 的那几张必然失败
  （RAW 是 JPEG 改后缀），纯 JPG 能否成功取决于引擎。要断言的是**账实一致**：
  清单 `rendered` 项都有同名成片、`failed` 项一个都没落地、结果条读数与清单相符。

## vitest 偶发超时

`e2e:unit` 用默认 pool（与 `npm test` 一致）。本机默认并发下偶发
`Test timed out in 5000ms`，且每次挂的用例不同 —— 是 `vitest.config.ts`
里记录的上游竞态，不是用例本身的问题。逃生阀（命令行，非终态）：

```bash
npx vitest run --pool=vmForks      # 换隔离策略，绕开默认 pool 的竞态
```
