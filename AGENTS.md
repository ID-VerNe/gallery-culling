# AGENTS.md — 本项目协作须知

给在本仓库工作的任何 AI agent（以及新加入的人类）的一页式说明。改动前先读完本文，尤其是「迭代流程」与「红线」两节。

---

## 0. 迭代流程（先读这一节）

所有仓库改动（代码、文档、门禁、配置）走五步，缺一步即不合规。细则：发 issue 看 [`doc/ISSUE_GUIDE.md`](doc/ISSUE_GUIDE.md)，开 PR 看 [`doc/PR_GUIDE.md`](doc/PR_GUIDE.md)。

1. **先发 issue（发现即提，不等批准）**：正文四要素齐全——现象（行为类必须带一条可直接粘贴的复现命令）/ 证据链（`文件:行号`）/ 影响面（P0–P2）/ 修复候选。给不出复现命令就贴 `needs-repro`。issue 是执行与验收的唯一依据。
2. **写 plan 追评到 issue 下面**：探索结论（带证据）+ 方案 + **明确不做** + 验证方式，并含一行「用 issue 的复现命令复现：成功 / 失败（贴原始输出）」。复现失败说明描述与现状不符，退回补充，不进实施；定稿后只追加不改口。模板见 [`doc/ISSUE_GUIDE.md`](doc/ISSUE_GUIDE.md)「写 plan：追评到 issue 下面」。
3. **开 worktree 改代码**：`git worktree add ../gallery-flask-<issue> -b type/<issue>-<slug> master`，不在主工作区切分支；分支 / PR 标题 / commit **三处都带 issue 号**。worktree 里没有 `node_modules` 与 `src-tauri/binaries`，见 PR_GUIDE「分支」一节。
4. **开 PR**：正文分段齐全（问题 / 改动 / 测试 / 基线验证 / 门禁改动 / 影响面 / 验收对照）；`Closes` 只给纯文档与纯重构，**行为类用 `Refs`**。**门禁链改动有机器闸门**：diff 触及 `scripts/check-*.mjs` / `gates.json` / `run-gates.mjs` / `ci.yml` / `.githooks/` 时，`## 门禁改动` 段要逐个交代并在**段末**贴独立复核结论（`scripts/check-gate-change-review.mjs` 判定，`<PENDING>` 或结论排在证据前都红）。推之前用 `node scripts/check-pr-parity.mjs --shard static` 证明本地绿在干净检出里也成立。**合并审批权归全新上下文的 subagent**（见 [`doc/PR_GUIDE.md`](doc/PR_GUIDE.md)「合并评审」），提交者不用等维护者人工点头；评审 `APPROVE` 后直接合并（merge commit，不 squash、不 rebase）。
5. **合并后对账与回签**：修复者逐项核对「自述 vs 实际」（`git status`、文件存在性、门禁原始输出），给行为类 issue 贴 `needs-live-verify`；由发现者或**全新上下文**的会话按 PR_GUIDE 的模板回签，**回签通过才关 issue**。修复者不能给自己回签，也不能给自己做合并评审。

### 0.1 门禁清单只有一个事实来源

本地与 CI 跑同一份清单 [`scripts/gates.json`](scripts/gates.json)，执行器是 `scripts/run-gates.mjs`：

```bash
npm run gates                              # 全量（tsc + vitest + cargo test，按清单顺序）
npm run gates:static                       # 只跑最便宜的一档（pre-push 用这个）
node scripts/run-gates.mjs ci --fail-fast  # 本机快速试错：见到红就停
node scripts/run-gates.mjs --list          # 看档位、分片与执行顺序
npm run parity                             # CI 等价复跑：在被推送 sha 的干净检出里跑同一份清单
```

- **新增门禁只改清单**，然后跑 `node scripts/check-gates-manifest.mjs --write` 重写下面这段；手改会被元门禁打红（磁盘脚本、清单、本节、`ci.yml` 分片矩阵四者必须一致）。
- 片内**串行**执行：并发跑会让 App 级集成用例在 5s 超时上假红（见 §0.2）。
- 真窗口 e2e（`npm run e2e:render` / `e2e:preset`）在 `manual` 档，CI 跑不了（WebView2 CDP 只服务第一个请求）。
- `check-pr-parity.mjs` 在 `support` 档**不进 CI**：它要在仓库里再开一个临时 worktree，在 CI job 里属于嵌套 worktree，风险大于收益——CI 本身就是那个干净环境。
- 钩子靠本地配置生效：`git config core.hooksPath .githooks`（换机器后重设一次）。`commit-msg` 拦文案格式与 `Co-Authored-By:`，`pre-push` 跑 static 分片再跑 parity（`SKIP_GATES=1` / `SKIP_PARITY=1` 可分别跳过并留痕）。

<!-- gates:ci:begin -->
> 本节由 `node scripts/check-gates-manifest.mjs --write` 从 `scripts/gates.json` 生成，**不要手改**；顺序即本机全量执行顺序，`分片` 列即 CI matrix 分片（同片串行、片间并行）。

| # | 分片 | 门禁 | 防什么 |
|---|---|---|---|
| 1 | `static` | `check-gates-manifest.mjs` | 元门禁：磁盘 check-*.mjs、本清单、AGENTS.md 生成段、ci.yml 分片矩阵四者零漂移 |
| 2 | `static` | `check-gate-change-review.mjs` | PR 改动触及门禁链时，正文必须有 `## 门禁改动` 段逐个交代 + 段末独立复核结论（issue #8）；无 PR 上下文 SKIP，显式声明改动却无 base 时 fail-closed |
| 3 | `static` | `check-fmt-baseline.mjs` | `cargo fmt --check` 差异处数不得超过 gates.json 的 fmtBaseline（防裸跑 fmt 重排整个 crate） |
| 4 | `static` | `tsc --noEmit` | TypeScript 类型检查（tsconfig 只覆盖 src，scripts 是纯 JS 不参与）。直指包内入口而非 `npx tsc`：本地缺席时 npx 会装同名包 `tsc@2.0.4`，它打印提示后 exit 0，门禁假绿（issue #24） |
| 5 | `static` | `check-theme-alpha.mjs` | 扫 src 里实际用到的「主题色+透明度」组合，逐个去 Tailwind 产物里核对有没有规则（issue #15）。配色写成 var(--color-*) 时 /NN 会被**静默丢弃**，不报错不警告，只有这条能盯住 |
| 6 | `static` | `check-version-sync.mjs` | `package.json`、`src-tauri/tauri.conf.json`、`package-lock.json` 的两处根版本必须一致（issue #23）。2.0.4 那次 bump 漏了 lock，`npm ci` 不报错、也没有门禁拦，不一致躺了一个版本 |
| 7 | `static` | `check-borders-emitted.mjs` | 扫 src 里所有描边颜色类，逐个去 Tailwind 产物里核对有没有规则（issue #18 · PD-1）。`border.default` 生成的是 `border-border-default`，写成 `border-default` 时一条规则都不产出、回落 currentColor（body 为 text-white，看起来是 100% 白线），只有这条能盯住 |
| 8 | `static` | `check-sidecar-lock.mjs` | sidecar 锁文件与磁盘产物一致（issue #73）：锁文件字段齐全、`version` 与 `PINNED_LUMEN_VERSION` 一致；产物在盘时再核 exe 哈希、目录文件数与 contentSha256。锁文件入库而 181.6MB 产物不入库，换产物没人报警只能靠这条。干净检出恒无产物，此时打印「未取回」并放行——CI 上固定红就失去意义 |
| 9 | `static` | `check-export-names.mjs` | 三处手写导出名一致性（issue #124）：解析 Rust 的 EXPORT_MANIFEST_NAME/EXPORT_TMP_PREFIX，与 TS exportMessages.ts 及 e2e 字面量逐个比对；改任一处后只有这条能变红 |
| 10 | `static` | `check-lens-parity.mjs` | 出厂镜头预设前后端一致（issue #125）：解析 TS 的 BUILTIN_LENS_PRESETS 与 Rust 的 builtin_lens_presets() 渲染成有序三元组逐条比对；改后端默认值而前端未同步时兜底/恢复默认会把旧表写回 DB，只有这条能变红 |
| 11 | `unit` | `vitest` | 前端全量用例；--pool=vmForks 见 vitest.config.ts 的 pool 说明（Windows 上的既定跑法）。直指包内入口而非 `npx vitest`：本地缺席时 npx 会去 registry 装 vitest@5（另一个大版本，可能真报绿），绕过了 package-lock（issue #24） |
| 12 | `rust` | `cargo test --lib` | 后端全量单测（真 tmpdir，不 mock fs）；7 例真机冒烟默认 ignored |

共 12 个 CI 门禁，分 3 个分片（static 10、unit 1、rust 1）；manual 2、support 1 见 `scripts/gates.json`。
<!-- gates:ci:end -->

### 0.2 证据与验证纪律

- **无证据不修复**：任何 finding 必须带可直接粘贴的 `文件:行号` 证据才进入修复；没有证据的视为虚构。
- **完成声明以磁盘为准**：任何「已完成」都要独立用 `git status`、文件存在性、门禁原始输出复核，不采信转述。
- **门禁安静窗口 solo 执行**：测试按序单独跑，不在并发写窗口内跑。红了先判断是代码问题还是环境问题——用 pristine HEAD 的 worktree 对照跑一遍；同族失败即既有抖动，记录在案，不要盲目「修复」。
- 已知抖动：满负荷跑全量时 `App.scanProgress` / `App.taskMutex` / `App.toneSave` 曾因默认 5s 超时假红（master 基线同条件复跑同样失败，单独复跑全绿）。2026-11-01 起 `vitest.config.ts` 的 `testTimeout` 放宽到 15s，只影响「卡住多久算挂」，不放松断言。
- 已知抖动（异步 DOM 断言等不到，非用例超时）：`MetadataEditorModal.presets.test.tsx` 的「显示的是库里的预设，不是写死的常量」在**满负荷整跑** `npm run gates` 的 unit 分片时偶发红——`findByRole('button', { name: /套用预设 Voigtlander VM 21mm F3.5/ })`（`src/components/MetadataEditorModal.presets.test.tsx:92`）撞 Testing Library 默认 1000ms 等待窗口，而弹窗已经打开（失败快照的 `<body>` 里已有 `fixed inset-0 z-50` 遮罩）。已观测 **1 次 / 2 次满负荷全量**（2026-11-05，issue #60）；隔离复跑 `node node_modules/vitest/vitest.mjs run src/components/MetadataEditorModal.presets.test.tsx --pool=vmForks` 与整分片复跑均 12/12 绿。
  - **判定方式**：同 SHA 单独复跑该文件通过，或用 pristine HEAD 的 worktree 同条件对照跑一遍；两者都绿即按抖动记录，不动实现。
  - **取舍**：不改全局 `testTimeout`（这次红的不是用例超时，调它无效，还会连带放宽全部前端用例的「卡住多久算挂」）；也不给这一条加显式等待窗口（只有 1 次观测、隔离复现不出来，等于在没复现的情况下改测试时序，会把真回归一起放走，违反红线 6「先让用例能红，再改实现」）。后续拿到「同 SHA、同机器、多次满负荷全量」样本再判断是否与 `useLensPresets` 的 IO 路径有关。
- **变异验证**：见红线 6。

---

## 1. 项目身份

| 项 | 值 |
|---|---|
| 产品名 | 摄影挑选/导出桌面应用（RAW 照片批量筛选 + 导出） |
| 包名（Cargo/tauri） | `gallery-culling` |
| 目录名 | `gallery-flask`（**与包名不一致，别被目录名误导**） |
| 技术栈 | Tauri 2.x + React 19 + TypeScript + Tailwind CSS |
| 包管理器 | **npm**（已从 pnpm 迁移，仓库里没有 pnpm-lock.yaml） |
| 主开发线 | `master`（改动走 issue → worktree → PR → 合并，见 §0；不再直接提交） |
| 平台 | 仅 Windows（WebView2），发版只出 NSIS setup.exe |

## 2. 红线（违反任何一条都不算完成任务）

1. **不留红 commit**。每一步改动完成即跑 `npm run gates`（= 清单里的 tsc + vitest + cargo test，见 §0.1）；涉及渲染/端到端行为时另跑 `npm run e2e:render`。
2. **`cargo fmt` 不裸跑**。基线里刻意保留 121 处格式差异（`scripts/gates.json` 的 `fmtBaseline`，会随新代码增长），裸跑会重排整个 crate、污染 diff。要格式化只针对自己新写的段落手工对齐；**新文件可以单独 `rustfmt --edition 2021 <file>`**（只碰它自己）。这条已由 `check-fmt-baseline.mjs` 门禁执行：差异处数超过基线即红。
3. **不动 `stash@{0}`**（历史遗留，内容未知）。
4. **不新建仓库内 CLAUDE.md**（本文件 AGENTS.md 是唯一协作说明）。
5. **批量删 Rust 顶层 item 的方法**：一次性读全文 → 切两段 → 拼回写盘。不要做两次独立的字符串切片，会撕破文件。
6. **测试方法论（先写测试，后改代码）**：
   - 先写测试 → 故意改坏关键逻辑（**变异**）验证测试网能抓到 → 还原 → 才准动实现；
   - **变异必须替换断言瞄准的子串**，在前面加无意义前缀是无效变异，测试不红不代表网有效；
   - E-07 教训：注释里描述的口径 ≠ 测试锁住的口径。`expectedFileCount` 注释写了「RAW + XMP + JPG」，但 fixture 全 `hasXmp: false`，XMP 分支零覆盖、变异存活。前端已在 1dc6373 补 XMP 用例（hasXmp: opts.xmp ?? false + useExportForm.test.ts XMP 分支用例），后端 XMP 覆盖已在 #132 补齐（export_copies_xmp_sidecar_alongside_raw + 跨语言契约表）。凡新增分支，必配能被变异打红的用例；
   - **变异还原不许用 `git checkout --`**（2026-10-19 事故）：对**未提交的跟踪文件** checkout 会把本轮全部接线冲回 HEAD，且 `git diff --stat` 输出为空、看不出异常。协议：先 `cp file /tmp/x.bak` 再变异，还原用 `cp` 回写；untracked 新文件 checkout 会直接报错（反而安全）。

## 3. 架构现状（SRP remediation 之后，别再往门面里塞东西）

- `src-tauri/src/lumen.rs`：3101 行 → **58 行门面 + 12 个子模块**
- `src-tauri/src/commands.rs`：1673 行 → **209 行门面 + 8 个子模块**
- `src/App.tsx`：1166 行 → **1134 行 + 24 个自定义 hook**（#112 抽出 `useScanSessionPolicy` 与状态栏/空状态纯 selector 后）
- 三个视口合计 1790 行 → 1278 行
- 共享层：
  - `src/utils/viewportZoom.ts` —— 缩放几何**单一真值**
  - `src/utils/viewportImage.ts` —— C2 RAW-only 规则：无 JPG 的 RAW 分组 `src` 必须为 `null`，**不回落 `.NEF`**
  - `src/hooks/useZoomPan` / `useDualZoomPan` —— 绝对系拖拽，抓取偏移存 ref
  - `src/hooks/useViewportImage`
  - `src/utils/lensPresets.ts` + `src/hooks/useLensPresets.ts` —— 镜头快捷预设（ADR-013）：**纯逻辑与 IO 分开**；`sanitizeLensPresets([])` 返回空数组，删空后**不复种**出厂 6 条
- `src-tauri/src/watermark.rs` —— 边框水印（ADR-012）：宿主自绘、只对 JPEG、挂点在导出临时文件上；4 预设 + 字号 8–35；运行时读系统字体链（msyh.ttc 优先，**不打包**）
- hooks 内部直接调 `useToast()` 是既定模式，不要往上传回调。
- 测试规模（2026-11-01）：Rust 352 个测试函数（345 通过 + 7 例真机冒烟 ignored）/ 前端 835 用例。

### 导出域规则（2026-10 UX 审计后固化，见 `.plan/export-ux-audit-2026-10-17.md`）

- **两条硬约束**：部分失败绝不伪装成功（`role="alert"` vs `role="status"` 是语义分工）；**取消 ≠ 失败**。
- **live region 独占**：进度条独占 `[aria-live="polite"]`；静态说明用 `aria-describedby`，不要再声明 `aria-live`。
- **disabled 按钮不可聚焦**：挂在它身上的 `title` / `aria-describedby` 键盘与读屏都拿不到。给禁用按钮的解释必须**常驻画在屏幕上**（footer 状态区），不能只放 title。
- **组 ≠ 文件**：`candidates` 数照片组；`exported` 按文件 +1（`export.rs`）。复制模式 1 组 = RAW + XMP + JPG 最多 3 个文件。前端口径真值是 `useExportForm` 的 `expectedFileCount`，改后端复制逻辑时必须同步。
- **`flag` 与 `rating` 是独立字段**（`CullFlag = 'none'|'pick'|'reject'`）。任何按 rating/类型筛的范围档都必须带 `flag !== 'reject'` 守卫——淘汰是删除意图，绝不能换个档位被导出。
- **原子覆盖**：`fs::rename` 在 Unix 是 `rename(2)`、Windows 是 `MOVEFILE_REPLACE_EXISTING`，都原子替换已存在目标，无空窗。覆盖开关默认 `false`；Rust 命令用 `overwrite: Option<bool>` + `unwrap_or(false)`，老前端不传保持旧行为。
- **清单兼容**：`ExportManifest` 新增字段一律配 `skip_serializing_if`（bool 用自写的 `is_false`，`std::ops::Not::not` 收值不收引用会类型不匹配）。`EXPORT_MANIFEST_NAME = ".gallery-export.json"` 前后端两处定义必须一致。
- **水印契约（ADR-012，2026-10-19）**：水印只对 JPEG 生效（`formatUsesWatermark`）；manifest 的 `watermark: Option<bool>` + `warning: Option<String>` 是**可省字段**——没要求水印的批次两个键整个不出现，`Some(false)` 才是「要求了但没加上」，**刻意不复用 `error`**（那意味着导出失败，而水印只是装饰）；`api.batchRenderExport` 第九参 `watermark` 没勾 / `enabled:false` 都**不传键**（「键不存在」正是清单要记录的状态，`src/services/api.test.ts` 锁着）；水印 EXIF 走 `read_exif_preferring_jpg`（配对 JPG 优先，0.14ms vs RAW 11.1ms，全项目唯一顺序）。
- **打开目录用 `open_folder_cmd`（opener 插件）**，不要走 `cmd /c start "" <path>`——路径含 `&` / `^` 会被 cmd 重新解析。

### 单一归属（新增代码的落脚点）

复制粘贴前先查下表；新代码收敛到既有归属，而不是再造副本（同 IdleJot 的 §2.5，本仓版）：

| 关注点 | 唯一归属 |
|---|---|
| 视口缩放几何 | `src/utils/viewportZoom.ts` |
| RAW-only 的 `src` 规则 | `src/utils/viewportImage.ts`（无 JPG 的 RAW 分组 `src` 必须为 `null`，不回落 `.NEF`） |
| 拖拽 / 缩放交互 | `src/hooks/useZoomPan` / `useDualZoomPan` |
| 导出文件数口径 | `src/hooks/useExportForm` 的 `expectedFileCount`（后端 `export.rs` 的 `exported` 必须同口径） |
| 导出清单字段兼容 | `src-tauri/src/export.rs` 的 `ExportManifest`（新字段一律 `skip_serializing_if`） |
| 边框水印 | `src-tauri/src/watermark.rs`（ADR-012，只对 JPEG） |
| 镜头快捷预设 | `src/utils/lensPresets.ts`（纯逻辑）+ `src/hooks/useLensPresets.ts`（IO） |
| 门禁清单 / 执行器 | `scripts/gates.json` + `scripts/run-gates.mjs`（**不要在别处再写一份命令数组**） |
| 迭代流程细则 | `doc/ISSUE_GUIDE.md` / `doc/PR_GUIDE.md` |

## 4. 环境坑（每个都真实踩过）

- **WebView2 崩溃红线（踩过两次：10-15、10-17）**：`main.rs` 只在 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` **未设置**时才写 `--in-process-gpu`。任何地方裸 set 这个变量都会把它抹掉 → GPU 子进程 STATIC_INIT 连崩 → 浏览器进程自杀 → 白屏 + `msedgewebview2 has stopped working`。加参数**必须**走 `e2e/lib/app.mjs` 的 `webviewArgs()`（显式前置 `--in-process-gpu`）。
- **e2e 只有应用内驱动这条路能跑**：本机 WebView2 CDP 只服务第一个请求，`e2e/run.mjs`（Playwright）的 `appPageReady()` 永远 false，只会白等超时。真窗口用例走 `npm run e2e:render` / `e2e:preset`（`e2e/run-inapp.mjs` + `src/devtools/e2eRunner.ts` + Vite `/__e2e_log`）。
- **vitest Windows pool 竞态**：必须 `--pool=vmForks`（`vitest.config.ts` 有注释）。
- **shebang + CRLF 会让 vitest 炸出无栈 SyntaxError（2026-11-01 首次 CI 实证）**：`autocrlf` 检出的 `.mjs` 若首行是 `#!...`，vitest 模块管线吐 `SyntaxError: Invalid or unexpected token`（不带任何栈），而 `node --check`、esbuild、原生 import 全都能过——极易误判为文件损坏。对策两条：`scripts/*.mjs` 一律不带 shebang（调用点全是显式 `node`）；`.gitattributes` 强制 `*.mjs text eol=lf`。用例锁在 `scripts/gates.test.mjs`。
- **clippy 的 "error deleting lock file 拒绝访问 (os error 5)" 是 incremental 锁环境噪音**，不是 lint。判断干净要先 grep 掉它，再看有无源码告警。
- **性能结论必须 release 口径**：`image` crate 内置 JPEG 编码器对优化级别极敏感——同一条 24MP 水印路径 debug 10.9s vs release **616ms**（差 18 倍）。任何写进文档的耗时数字都要 `cargo test --release` 实测，debug 数字只在调试时看。
- **`cargo test` 并发全量时 `syncqueue::burst_writes_once_with_latest_value`（400ms 合并窗口计时）会假红**，单独重跑即过。判断测试真假先隔离复跑，别急着改实现。
- **Rust `#[tauri::command]` 宏不随 glob 导入传递**：`lib.rs` 的 `generate_handler` 必须写 `commands::xxx_cmd` 限定路径；子模块宏要在 `commands.rs` 逐个显式转发（含 `__cmd__` 与 `__tauri_command_name_` 符号）。
- **子模块命名避让**：`xmprw`（不叫 xmp）、`lumencmds`（不叫 lumen）。
- **Tauri v2 ACL**：`core:window:default` 的 28 项权限**不含** `allow-destroy` / `allow-close`。前端 `preventDefault()` 后调 `appWindow.destroy()` 必须在 capabilities 里显式授 `core:window:allow-destroy`，否则窗口被拦住且永远关不掉。jsdom mock 抓不到这类问题，只能真窗口验。
- **Tauri 命令参数即 IPC 契约**：参数多了触发 `too_many_arguments` 时加 `#[allow]` + 注释，不要为闭嘴去拆结构体（会连带改前端调用形状）。
- **sidecar 产物不在版本库、锁文件在（issue #73）**：`src-tauri/binaries/lumen-cli/`（1150 个文件 / 190,420,760 字节）被 `.gitignore` 忽略，干净检出里**没有**它；入库的是 `src-tauri/sidecar.lock.json`，钉住版本、exe 哈希、目录文件数与 `contentSha256`。换机器 / 清空 binaries 后，构建前必须先取回，否则 `beforeBuildCommand` 里的 `prepare-sidecar` 会 fail-closed：
  ```bash
  $env:LUMEN_SIDECAR_SRC="<产物目录>"; node scripts/prepare-sidecar.mjs   # 复制 + 校验
  node scripts/prepare-sidecar.mjs --fetch                                  # 看「无公开来源」的说明
  ```
  只有**有意更换产物**才允许 `node scripts/prepare-sidecar.mjs --update-lock`，且必须核对来源并说明理由；门禁 `check-sidecar-lock.mjs` 会在产物在盘时逐项比对，不一致即红。

## 5. Commit 与发布

### Commit message

- 格式 `type(scope): 中文摘要（issue #NN）` + 正文。**三处带 issue 号**：分支名、PR 标题、commit。正文实际沿用仓库习惯：中文要点列表（`- ` 起头），说清**为什么这么改**与实测数字，不要只列改了哪些文件；参考 `git log` 里 `feat(album)` / `docs(album)` 那几篇。
- **逐个 `git add <file>`**，禁止 `git add .` / `-A` / 目录批量；提交前跑 `npm run gates`（见红线 1），push 前确认 `git status` 干净。
- Commit message 里**禁止** `Co-Authored-By:` 行——`.githooks/commit-msg` 会直接拦下；同一钩子也校验首行格式。

### 发布流程（v2.0.1/v2.0.3 实证）

> **发版前先确认 sidecar 产物到位**：`node scripts/prepare-sidecar.mjs` 必须打印「与锁文件一致」。换机器 / 清空 `src-tauri/binaries/` 后先用 `LUMEN_SIDECAR_SRC` 复制（见 §4）；产物与 `src-tauri/sidecar.lock.json` 不一致时**禁止发版**——那说明装进去的是另一个引擎。

1. 版本号改两处：`package.json` + `src-tauri/tauri.conf.json`（`Cargo.toml` 的 lib 版本恒为 1.0.0，**不跟随**）。版本约定 `vX.Y.Z`。
2. bump 提交并 push。
3. **发版前必跑真窗口 e2e**：`scripts/release.mjs` 会先跑 `npm run e2e:ui`（ui-contract），**红则中止**、不产出 `updater.json`；确需跳过只能用 `SKIP_E2E=1` 并在发布输出留痕。
4. 签名构建 + 发布后半段（thin LTO 首编约 12 分钟）。**推荐一条命令跑完**（`--publish`，issue #83）：
   ```powershell
   $env:RELEASE_NOTES = Get-Content notes.txt -Raw
   node scripts/release.mjs --publish
   ```
   构建之后自动接续：提交 `updater.json`（仓库根，tracked）→ push master（**老客户端读 master 的 raw 地址，推上去即触发更新弹窗**）→ 打 annotated tag 指向该提交 → REST 建 draft Release（`gh release create` 在本项目的 GraphQL 会返回 EOF）→ **只传 NSIS setup.exe**（MSI 不传）→ 置为已发布 → 核对资产 digest 与 `releases/latest`。末尾打印结构化终态：
   ```
   version=vX.Y.Z / tag=vX.Y.Z -> <sha> / release=<url> / asset=<name> size=<bytes>
   digest=sha256:<hex> match=yes|no / latest=vX.Y.Z match=yes|no / status=PUBLISHED|FAILED
   ```
   **失败即非 0 退出**并打印 `stage=<步骤>`；**只允许在 `master` 分支执行**（tag 打在 HEAD、清单必须进 master，其它分支直接中止）。幂等——重跑会跳过已提交 / 已打 tag / 已上传且 digest 一致的步骤（清单除 `pub_date` 外没变化时沿用旧 `pub_date`）。但构建产物不可逐字节复现：**tag 已存在而本次重建的签名不同时，脚本在提交前就中止、不 push 任何东西**——这种情况请 bump 版本号重发，而不是硬重跑。
   `RELEASE_NOTES` 会写进 `updater.json` 的 `notes`（客户端更新弹窗文案），缺省为「🚀 应用有新版本发布啦！」。不带 `--publish` 时行为与历史一致（只构建），收尾打印手工步骤。
5. 手工退路（`--publish` 不可用时逐条执行；签名私钥 `updater.key` 为 gitignored）：
   - 提交 `updater.json` 并 push。
   - 打 annotated tag，**指向 updater.json 的提交**，message = 版本号：
     ```powershell
     git tag -a v2.0.3 -m "v2.0.3"; git push origin v2.0.3
     ```
   - 建 Release 并上传资产（**只传 NSIS setup.exe**，走 REST，别用 `gh release create`）：
     ```powershell
     gh api -X POST repos/ID-VerNe/gallery-culling/releases -f tag_name=v2.0.3 -f name=v2.0.3 -f body="$(Get-Content release-notes.md -Raw)"
     gh release upload v2.0.3 "src-tauri/target/release/bundle/nsis/gallery-culling_2.0.3_x64-setup.exe"
     ```
   - 核对 `gh api repos/ID-VerNe/gallery-culling/releases/latest` 已指向本版本。

## 6. 文档索引

| 文件 | 内容 |
|---|---|
| `doc/ISSUE_GUIDE.md` | 怎么发 issue：正文四要素、复现命令与 `needs-repro`、关闭方式、模板 |
| `doc/PR_GUIDE.md` | 怎么开 PR：拆分命名、正文分段、基线验证、门禁改动与独立复核、合并条件、对账与回签 |
| `scripts/gates.json` | 门禁清单**唯一事实来源**（§0.1 的生成段由它渲染） |
| `scripts/check-gate-change-review.mjs` | 门禁链改动披露闸门：PR 改动命中门禁链时，正文必须有 `## 门禁改动` 段 + 段末独立复核结论（issue #8） |
| `scripts/check-pr-parity.mjs` | CI 等价复跑：在被推送 sha 的干净检出里跑同一份清单（issue #8） |
| `.plan/iteration-workflow-2026-11-01.md` | issue #6 的实施方案（移植对照表、门禁契约、测试计划） |
| `.plan/iteration-workflow-gates-2026-11-01.md` | issue #8 的实施方案（披露闸门、parity、时点边界） |
| `.plan/export-ux-audit-2026-10-17.md` | 导出 UX 审计：14 条 finding、评分 6/10、修复依据 |
| `.plan/execution-log-2026-10-14.md` | 16-18 节是 FE-03b/FE-06/FE-07 全程记录 |
| `.plan/remediation-verification-ledger-2026-10-13.md` | 62 项逐条裁决台账 |
| `.plan/adr-001` – `adr-013` | 十三份 ADR（旗标存储 / 写盘合并 / 色标 / 撤销栈 / 查询筛选 / 套用调色 / 任务互斥 / XMP 增量 / RAW 1:1 / 选片集 / LR 导入 / 宿主水印 / 镜头预设自定义），每份含「代价与风险」 |
| `.plan/lens-presets-custom-2026-11-01.md` | issue #4 的实施方案（存储选型对比、契约、测试计划） |
| `.plan/rendered-export-design-2026-10-17.md`、`rendered-export-ux-ui-plan-2026-10-17.md` | 成片导出设计与 UX 方案 |
| `docs/lumen-benchmark-2026-10-18.md` | 与 LUMEN 的 26 项能力对照矩阵（含「读法」与 10-19 更新行） |
| `.handoffs/` | 交接文档 |
| `e2e/README.md` | e2e 双体系说明（为何只有应用内驱动可用） |

## 7. 工作习惯

- 改前先读相关文件的现状与注释——本项目注释密度高，多数「为什么」都写在代码旁边，别靠猜。
- 修 bug 前先确认测试网：没有能红的用例就先补，再修。
- 新增行为同时更新四档测试里对应的那几档；Rust 侧新命令至少一条集成式单测（真文件系统 tmpdir，不用 mock fs）。
- 语义化中文文案：错误提示要给「下一步怎么办」，不要只报状态码。
