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
npm run e2e:external  # 真窗口：外部打开回落链三条 toast 可见（issue #106 非提权半壁）
npm run e2e:session   # 真窗口：退出 → 重启 → 同目录断点恢复（issue #108，两段进程）
npm run e2e:thumb     # 真窗口：冷启动 / 切面板 / 重开的缩略图缓存（issue #107，两段进程）
npm run e2e           # 全档串起来（unit + rust + render + ui），全绿才算过
```

真窗口用例的参数：

```bash
node e2e/run-inapp.mjs --scenario=render-export
node e2e/run-inapp.mjs --scenario=lumen-preset
node e2e/run-inapp.mjs --scenario=ui-contract
node e2e/run-inapp.mjs --scenario=external-fallback
node e2e/run-inapp.mjs --scenario=render-export --timeout=600000

# detail-1to1 必须用**真实 ARW**：夹具里的 RAW 是 JPEG 改后缀，photo.export
# 解不出图，1:1 永远走不到 —— 用夹具跑出来的「通过」毫无意义。
# 不带参数时自动探测 ~/Pictures/Camera Roll；也可显式覆盖：
npm run e2e:detail
GALLERY_REAL_RAW_DIR='D:/photos/raw' npm run e2e:detail
node e2e/run-inapp.mjs --scenario=detail-1to1 --raw-dir='D:/photos/raw'
```

自动探测（`e2e/lib/real-raw.mjs`）按文件头 magic（ARW `II*\0` / `MM\0*`、
CR3 `ftypcrx`、RAF `FUJIFILM`）+ 1 MiB 体积门槛排除 JPEG 改后缀的假 RAW；
从 `os.homedir()/Pictures/Camera Roll` 起逐棵深度优先找 ≥2 张，选中的两张
**硬链接**到 `e2e/.tmp/realraw`（跨卷时回落复制），所以 `VITE_E2E_RAW`
永远只含这两张，扫描时是 RAW-only 组。`node e2e/lib/real-raw.mjs --probe`
只打印会自动挑中的来源与文件名，不建目录，便于人工核对。

显式目录仍兼容旧布局：先看 `<dir>/rawonly/`，没有再看目录本身，仍不足
再递归；`run-inapp.mjs` 取前两张的 baseName，清空细节缓存后交给场景，
断言首次 ≤10s、`scale` 真的是 `naturalWidth / offsetWidth`、命中 ≤2s、
取消后仍停在预览且再按 Z 能重新认领。

退出码：`0` 全绿 / `1` 有用例失败 / `2` 启动或超时或缺少真实素材。

## 它自己管生命周期

`e2e:render` 一条命令做完：

1. **重建素材** —— 每次清空 `e2e/.tmp/fixtures/` 重新生成（测试会就地写 rating/tone/export，不清就会互相污染）；
2. **启动应用** —— 起 `tauri dev`，就绪信号是 `e2e/.tmp/e2e-app.log` 里出现场景日志（不是 CDP，见下节）；
3. **等场景跑完** —— 应用内执行场景，日志同源落盘；
4. **断言** —— 读日志断言 UI 表现，读文件系统断言落盘与清单；
5. **优雅关闭应用** —— 触发会话 flush 后回收整棵 dev 进程树。

首次或改过 Rust 要重新编译，启动约 30–90s；之后整轮约 2–4 分钟。

## 两段进程（重启套件：`e2e:session` / `e2e:thumb`）

issue #108 / #107 的契约是「跨重启」的，所以编排器把一条场景拆成两段进程：

1. phase 1 在应用内跑完前半段（点选第 N 张 / 建立缩略图基线），落标记 `=== e2e phase1 done (`；
2. 编排器**优雅关窗**（触发 `onCloseRequested → flush → destroy`）→ `killDevTree`
   整棵回收 → 同 `GALLERY_DATA_DIR` 重开（**数据目录不重置**，会话 / 缓存正是要证明它活着）；
3. phase 2 的进程经 `VITE_E2E_PHASE=2` 知道自己是「重启后」，跑后半段硬断言。

段间的硬断言由编排器直接做，不经浏览器：`session-restore` 用 python sqlite3
读 `sessions.last_index`（与 issue #108 复现命令同一口径）；`thumb-cache` 对
`<数据目录>/cache` 做文件名 + size + mtime 快照比对（mtime 变 = 重新生成过）。
期望值（N / baseName / IMG_001 缓存文件名）由 phase 1 日志实测解析后经 env 注入 phase 2，不写死。

## 期望断言集合（issue #188）

编排器对场景日志的断言行（`>>> 断言X … = true|false`）不只比「解析数 == 出现数」：
某条断言因上游条件不满足而根本没下发时，出现数同步少 1，旧等式仍成立会假绿。

- 期望表在 `e2e/lib/assertions.mjs` 的 `EXPECTED_ASSERTIONS`，按场景分四档：
  `required`（必备 token，缺一条即红）、`conditional`（条件降级断言：断言行**或**
  `>>> 断言X 跳过（原因：…）` 显式跳过行二选一，两者皆无才红）、`anyOf`（互斥结果
  分支组，至少命中一组）、`minCount`（解析数下限，兜底「只剩一条也绿」）。
- 条件降级不许静默：`src/devtools/e2eRunner.ts` 里条件不满足的分支必须补一条显式
  跳过行；跳过行不带 `= true|false`，由编排器单独识别。
- 判定是纯函数（输入日志文本 + 期望表 → 结构化结果），node 侧单测在
  `src/devtools/e2e-assertions.test.mjs`，不依赖真窗口。新增或调整场景断言行时，
  同步更新期望表；表内 token 与 `e2eRunner.ts` 的 `>>> 断言<token>` 逐字对应。

### 冻结基线（2026-11-14 本机真机逐场景实发集合）

期望表按真机实发集合冻结，不照代码行数写。各场景实发条数：

| 场景 | 实发 | token 集合 |
|---|---|---|
| `ui-contract` | 46 | 表内 46 条（U/G/R 系列） |
| `detail-1to1` | 16 | D1 D2 D3 D4 D5 D6 D7 C-1 C-2 D8 D9 D10 D11 D12 D13 D14 |
| `external-fallback` | 5 | F1 F2 F2a F2b F3 |
| `thumb-cache` | 5 | T1 T3 T4 T7 T5（T7 条件项，单段手动跑走跳过行） |
| `session-restore` | 8 | S1 S2 S4 S5 S7 S7b S8 S9 |
| `engine-download` | 6 | E1 E2 E3 E4 E5 E6 |
| `lumen-preset` | 4 | A1 A2 A3 B1 |
| `render-export` | 10 | R1 R2 R3 R4 R5 R12 R11 + R8 R9 R10 |

差异与备注说明：

- **detail 代码 16 行 / 历史记录 11 条**：历史「11 条」是早期基线数字，夹具与断言
  扩充后没回写；本次真机两跑均实发 16 条，以冻结表为准。
- **render-export 互斥分支**：引擎可用走 R8/R9/R10，不可用走 R6/R7，`anyOf` 只要求
  命中一组，两组不会同时出现。
- **detail 时序 false 与集合无关**：D4（首次 ≤10s）、D14（重渲 <12s）在本机 debug
  构建下两跑均超时（27.3s / 63s），D13 偶发；属既有环境时序抖动，不是缺断言，
  不在本 lane 修。

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

`e2e/run.mjs` + `suites/01-08` 是旧的 Playwright 路线，本机只会白等到超时。
**DEPRECATED**：保留只为在 CDP 正常的机器上仍可用，不再新增用例、不纳入
`npm run e2e` 或发版闸门；新用例一律走 `run-inapp.mjs`。

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
  「宫格列表 (107) · 已选 1」最宽左状态后，格头右侧 **7 个控件**
  （全选/清除/搜索/3列/4列/未修/已修）单行（top 极差 ≤1px、高 ≤32px、各自
  `scrollWidth ≤ clientWidth`）、控件组总宽 ≤370px（390 侧栏 − px-2.5×2）、
  不越格头内右缘、左状态不压控件组、格头行与 390px 侧栏都无横向溢出；
  七个控件中心逐个 `elementFromPoint` 必须命中自身（#200 新加的两个按钮
  不能被相邻控件压住）。
- **#200 已修徽章与筛选**：夹具 `IMG_010` 旁空 `.acr`（文件旁证）、`IMG_011`
  的 sidecar 写 `crs:HasSettings="True"`（内容判据），两条判定路径都必须在
  格头 `aria-label` 与单图预览的 `role="img"` 徽章上可见；点「已修」后
  「宫格列表」为 2、点「未修」为 10，`aria-pressed` 与激活态一致，再点一次
  取消必须回到 12，两个按钮中心命中自身。

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

## `external-fallback` 覆盖什么（issue #106 · 非提权半壁）

外部打开的回落链（`useExternalApps.ts`）三条 toast 在**真窗口 DOM** 里可见：

- F1：`api.openInPhotoshop` 回 `false`（PS 路径未配置/不存在，Rust 已回落默认程序）→ `role="status"` 出现「Photoshop 路径未配置或不存在，已改用默认程序打开。」；
- F2：`openInPhotoshop` 抛错（catch 分支）→ 替身记账证明 `openInDefaultApp` 真被调，且 `role="status"` 出现「Photoshop 打开失败，已改用默认程序打开。」；
- F3：回落也抛错 → `role="alert"` 出现「无法打开该照片」（错误级不自动消失）。

场景在 dev bundle 里 monkey-patch `api.openInPhotoshop` / `api.openInDefaultApp`（同模块单例，调用点取属性即生效），既驱动前端完整分支，又把 `explorer.exe` 副作用挡在窗外。实现层的 jsdom 用例在 `src/hooks/useExternalApps.test.tsx`，本场景补真窗层。

issue #106 的提权两场景（已开 PS 收不到 RAW / 新起 PS 未提权）要管理员真机 + UAC + 进程 IL 实测，应用内 e2e 够不到，仍留人工回签（issue 保持 OPEN）。

## 覆盖边界（刻意分层，不是漏测）

真窗口一轮 2–4 分钟，只留给「jsdom 证不了」的契约。以下三条链路**不由本目录
重复覆盖**，改动时看对应档位：

| 能力 | 归属 | 为什么不进真窗口 |
|---|---|---|
| 边框水印 | `src-tauri/src/watermark.rs` 单测 + `scripts/check-watermark.mjs`（预设名/尺寸四份一致）+ 导出 UX 用例 | 像素级字体渲染与 24MP 耗时用例放 Rust 更快、更稳；真窗口不重复像素级水印断言 |
| 镜头快捷预设 | `src/utils/lensPresets.ts` 纯逻辑用例 + `src/hooks/useLensPresets.test.tsx` + `scripts/check-lens-parity.mjs`（前后端出厂表一致） | 逻辑与 IO 已分离，jsdom 能覆盖增删改与恢复默认；真窗口重复一遍只会增加启动成本 |
| 选片集（Album） | `src/utils/albumGroups.test.ts` + Rust album 单测（含 `.acr` / 配对 JPG 口径） | 数据层与命令层已锁死；真窗口只在扫描/刷新路径上顺带验，不为它单开场景 |

新增真窗口场景的门槛：**只有真浏览器/真磁盘/真 IPC 才能证伪**。纯状态机、
纯字符串、纯数据映射留在 vitest 或 Rust。

## 目录

```
e2e/
  run-inapp.mjs           应用内驱动编排器（真窗口用例走这条）
  run.mjs                 旧 Playwright 编排器（DEPRECATED，本机不可用）
  lib/
    app.mjs               应用生命周期：启停 / 端口回收 / 日志等待
    harness.mjs           CDP 连接、弹窗清理、底栏读取、断言与报告（旧路线用）
    real-raw.mjs          真实 RAW 自动探测 + detail 夹具准备（issue #212）
    close-app.ps1         CloseMainWindow（触发 onCloseRequested）
  fixtures/
    generate.mjs          确定性素材 + EXPECTED 期望态表
  suites/                 旧 Playwright 套件（01-08，DEPRECATED）
  .tmp/                   运行时产物（素材 / 日志 / realraw），已 gitignore
```

## 期望值只有一份

`fixtures/generate.mjs` 导出 `EXPECTED` 表（每张素材的星级/旗标/是否已修
真值），套件从它**推导**断言，而不是在校验里另抄一份数字。改素材只需改这一处。

## 素材说明

- JPG：内嵌的 480×360 真 JPEG（base64）。尺寸是刻意的 —— 缩略图管线要走
  「取内嵌预览 → 否则按宽度缩放」，用 64×48 的迷你图会让缩放路径失去意义。
- WIDE：107 张同名规律 JPG（#105 格头夹具，只有 JPG 无 sidecar），只在
  `ui-contract` 场景的几何断言里扫描；其余场景不读它，素材体积可忽略。
- XMP：8 个真 sidecar，覆盖 pick / reject（`Rating=-1` 与 `Label=Red` 两种约定）/
  普通星级 / 带 tone / `Label=None` 边界 / `crs:HasSettings="True"`（#200
  内容判据，`IMG_011`）。
- ACR：`IMG_010.acr` 空文件，覆盖 #200 的第二条判定路径（图片旁同名
  `.acr` 即视为已进 ACR/PS，不看内容）。两条路径各锁一张，任何一条被改坏
  都会让 `ui-contract` 的 R1/R2 变红。
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
