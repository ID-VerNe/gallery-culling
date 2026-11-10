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
npm run e2e:detail    # 真窗口：RAW-only 1:1 细节（需要真实 ARW，见下）
npm run e2e:ui        # 真窗口：状态栏常驻 / 按钮命中 / 左手别名（issue #53 → #62）
npm run e2e           # 全档串起来（unit + rust + render + ui），全绿才算过
```

真窗口用例的参数：

```bash
node e2e/run-inapp.mjs --scenario=render-export
node e2e/run-inapp.mjs --scenario=lumen-preset
node e2e/run-inapp.mjs --scenario=ui-contract
node e2e/run-inapp.mjs --scenario=render-export --timeout=600000

# detail-1to1 必须用**真实 ARW**：夹具里的 RAW 是 JPEG 改后缀，photo.export
# 解不出图，1:1 永远走不到 —— 用夹具跑出来的「通过」毫无意义。
GALLERY_REAL_RAW_DIR='C:/.../gallery-realraw-20261018' npm run e2e:detail
node e2e/run-inapp.mjs --scenario=detail-1to1 --raw-dir='C:/.../gallery-realraw-20261018'
```

`GALLERY_REAL_RAW_DIR` 指向的目录要含 `rawonly/`（≥2 张真实 RAW）：
`run-inapp.mjs` 取前两张的 baseName，清空细节缓存后交给场景，
断言首次 ≤10s、`scale` 真的是 `naturalWidth / offsetWidth`、命中 ≤2s、
取消后仍停在预览且再按 Z 能重新认领。

退出码：`0` 全绿 / `1` 有用例失败 / `2` 启动或超时或缺少真实素材。

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

## `ui-contract` 覆盖什么（issue #53 · issue #62 改写）

底栏的几类契约只有真实浏览器能证伪，vitest（jsdom）只能看 `className`：

`ui-contract` 启动时经 `tauri dev --config e2e/.tmp/window-1280.json` 把窗宽
合入 1280（`e2e/lib/app.mjs` 的 `windowWidth` 参数；其余场景仍用
`tauri.conf.json` 的 1400），为 #99 的窄窗几何提供真窗条件。

### 几何三件（#100 · #105 · #99，真窗 `getBoundingClientRect` 实测）

- **#100 色点同心**：`Shift+1` 设红标后，白色选中环（按钮盒）与色点
  （内部 span）中心差 `|dx|,|dy| ≤ 1px`；五个色点 `top` 极差 ≤1px（基线
  同 y）、每个 12x12（±0.5px）。
- **#99 窄窗状态栏**：先自报 `innerWidth` 落带（1024≤w<1300，窄窗没真生效
  即红）；`[data-status-group]` 全部 rect 两两不相交（容差 0.5px）；
  状态栏与窗格的 `scrollWidth ≤ clientWidth`（不横滚）；组盒子不逃出 pane；
  断点组 visible 与 `matchMedia` 一致（2xl 体积组在窄窗必须 hidden、lg
  参数组必须 visible）；身份/参数组 `overflow-x=hidden`（漆面不越盒，
  computed style 补齐——纯几何量不出「裁掉」与「画过去」的区别）。
- **#105 格头控件**：`WIDE` 夹具（107 张 JPG，`VITE_E2E_WIDE`）扫出
  「宫格列表 (107) · 已选 1」最宽左状态后，格头右侧 5 个控件
  （全选/清除/搜索/3列/4列）单行（top 极差 ≤1px、高 ≤32px、各自
  `scrollWidth ≤ clientWidth`）、控件组总宽 ≤370px（390 侧栏 − px-2.5×2）、
  不越格头内右缘、左状态不压控件组、格头行与 390px 侧栏都无横向溢出。

- **常驻与占位**（#62 替代 #47 的「静息整条移出视口」）：`[data-status-bar]` 必须是
  文档流元素，`top >= [data-viewport-photo] 的 bottom - 1`，`opacity >= 0.95`，
  且落在窗口底部之内；旧的 `[data-bar-handle]` **必须不存在**（旧方案被加回来就红）。
  照片区底部内侧 18px 处做 `elementFromPoint` 探针，命中不得是状态栏 —— 这是
  「照片区真的缩短了、没被盖住」的直接证据。
- **键盘与几何**：状态栏首个星级按钮可聚焦；聚焦前后 `top` 差 ≤1px（不再有
  「唤回」位移，#47 的可发现性问题在常驻方案下不再成立）。
- **按钮命中**：对每个启用按钮的中心做 `document.elementFromPoint`，
  断言命中的是按钮自身或其后代（透明命中层 / `pointer-events:none` 继承都会在这里断）。
- **左手别名**：同一张照片上 `F`↔`P`、`R`↔`0`、`T`↔`Y`、`Shift+1…5`↔`6–9`/`Shift+6`
  产生同一组 `aria-pressed` 真值；`V`↔`\` 按住时读的是「正在查看原片」横幅，
  松开后必须消失。

更新装完不自动重启（#49）依赖 NSIS 安装器与提权进程，应用内驱动够不到，仍留人工回签。

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
- WIDE：107 张同名规律 JPG（#105 格头夹具，只有 JPG 无 sidecar），只在
  `ui-contract` 场景的几何断言里扫描；其余场景不读它，素材体积可忽略。
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
