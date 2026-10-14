# 真窗口 E2E（`e2e/`）

连**真实 Tauri 窗口 + 真实 Rust 后端**跑端到端回归，不是 mock。

与 `src/test/`（vitest）的分工：

| | vitest（`e2e:unit`） | 本目录（`e2e:app`） |
|---|---|---|
| 对象 | 组件 / hook 逻辑 | 真窗口 + 真后端 + 真磁盘 |
| IPC | mock 掉 | 真发 |
| 速度 | 秒级 | 分钟级 |
| 能抓到 | 状态机、渲染分支 | XMP 落盘、扫描配对、导出文件、会话持久化 |

## 跑法

```bash
npm run e2e:unit      # 前端 336 条（vitest）
npm run e2e:rust      # Rust 128 条（cargo test --lib）
npm run e2e:app       # 真窗口 105 条（本目录）
npm run e2e           # 三档串起来，全绿才算过
```

`e2e:app` 常用参数：

```bash
npm run e2e:app -- --only=02,05      # 只跑指定套件
npm run e2e:app -- --skip-session    # 跳过要重启应用的那套
npm run e2e:app -- --attach          # 连已在跑的实例（不自己启停）
```

退出码：`0` 全绿 / `1` 有用例失败 / `2` 启动或编排失败。

## 它自己管生命周期

`e2e:app` 一条命令做完：

1. **重建素材** —— 每次清空 `e2e/.tmp/fixtures/` 重新生成（测试会就地写 rating/tone/export，不清就会互相污染）；
2. **启动应用** —— 带 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 起 `tauri dev`，轮询到 CDP 就绪且应用页面挂上；
3. **逐个套件** —— 连 CDP 驱动真窗口；
4. **关闭应用** —— 优雅关窗（触发会话落盘）后回收整棵 dev 进程树。

首次或改过 Rust 要重新编译，启动约 30–90s；之后整轮约 3 分钟。

## 为什么走 CDP

Tauri 的 WebView2 **不**把 DOM 暴露给 Windows UI Automation，所以无法用 UIA 断言界面。
`--remote-debugging-port` 让 WebView2 开一个 CDP 端点，Playwright 用
`chromium.connectOverCDP()` 连上去 —— 测的仍是真窗口与真后端。

## 目录

```
e2e/
  run.mjs                 编排器（重建素材 → 启停应用 → 跑套件 → 汇总）
  lib/
    app.mjs               应用生命周期：启动 / 就绪探测 / 优雅关闭 / 重启
    harness.mjs           CDP 连接、弹窗清理、底栏读取、断言与报告
    close-app.ps1         CloseMainWindow（触发 onCloseRequested）
  fixtures/
    generate.mjs          确定性素材 + EXPECTED 期望态表
  suites/
    01-scan.mjs           扫描 + 筛选计数 + 缩略图解码
    02-rating.mjs         星级/旗标/撤销 + XMP 落盘字节校验
    03-nav.mjs            键盘导航、视图模式、缩放、搜索、多选
    04-tone.mjs           调色面板 + 非破坏性写回
    05-export.mjs         批量导出 + 同目录护栏 + manifest
    06-raw-settings.mjs   RAW 配对 + 设置持久化
    07-session.mjs        关窗重启后的会话恢复
  .tmp/                   运行时产物（素材 / 日志 / 截图），已 gitignore
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

## vitest 偶发超时

`e2e:unit` 用默认 pool（与 `npm test` 一致）。本机默认并发下偶发
`Test timed out in 5000ms`，且每次挂的用例不同 —— 是 `vitest.config.ts`
里记录的上游竞态，不是用例本身的问题。逃生阀（命令行，非终态）：

```bash
npx vitest run --maxWorkers=1      # 本机验证 336/336 全绿，但慢（约 5 分钟）
```
