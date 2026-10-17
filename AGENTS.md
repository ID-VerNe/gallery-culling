# AGENTS.md — 本项目协作须知

给在本仓库工作的任何 AI agent（以及新加入的人类）的一页式说明。改动前先读完本文，尤其是「红线」一节。

---

## 1. 项目身份

| 项 | 值 |
|---|---|
| 产品名 | 摄影挑选/导出桌面应用（RAW 照片批量筛选 + 导出） |
| 包名（Cargo/tauri） | `gallery-culling` |
| 目录名 | `gallery-flask`（**与包名不一致，别被目录名误导**） |
| 技术栈 | Tauri 2.x + React 19 + TypeScript + Tailwind CSS |
| 包管理器 | **npm**（已从 pnpm 迁移，仓库里没有 pnpm-lock.yaml） |
| 主开发线 | `master`（直接提交或 fix 分支 + PR 均可） |
| 平台 | 仅 Windows（WebView2），发版只出 NSIS setup.exe |

## 2. 红线（违反任何一条都不算完成任务）

1. **不留红 commit**。每一步改动完成即跑：
   - `npx tsc --noEmit`
   - `npx vitest run --pool=vmForks`（全量）
   - `cargo test --lib`（在 `src-tauri/` 下）
   - 涉及渲染/端到端行为时另跑 `npm run e2e:render`
2. **`cargo fmt` 不裸跑**。基线里刻意保留约 48 处格式差异，裸跑会重排整个 crate、污染 diff。要格式化只针对自己新写的段落手工对齐。
3. **不动 `stash@{0}`**（历史遗留，内容未知）。
4. **不新建仓库内 CLAUDE.md**（本文件 AGENTS.md 是唯一协作说明）。
5. **批量删 Rust 顶层 item 的方法**：一次性读全文 → 切两段 → 拼回写盘。不要做两次独立的字符串切片，会撕破文件。
6. **测试方法论（先写测试，后改代码）**：
   - 先写测试 → 故意改坏关键逻辑（**变异**）验证测试网能抓到 → 还原 → 才准动实现；
   - **变异必须替换断言瞄准的子串**，在前面加无意义前缀是无效变异，测试不红不代表网有效；
   - E-07 教训：注释里描述的口径 ≠ 测试锁住的口径。`expectedFileCount` 注释写了「RAW + XMP + JPG」，但 fixture 全 `hasXmp: false`，XMP 分支零覆盖、变异存活。凡新增分支，必配能被变异打红的用例。

## 3. 架构现状（SRP remediation 之后，别再往门面里塞东西）

- `src-tauri/src/lumen.rs`：3101 行 → **58 行门面 + 12 个子模块**
- `src-tauri/src/commands.rs`：1673 行 → **209 行门面 + 8 个子模块**
- `src/App.tsx`：1810 行 → **686 行 + 22 个自定义 hook**
- 三个视口合计 1790 行 → 1278 行
- 共享层：
  - `src/utils/viewportZoom.ts` —— 缩放几何**单一真值**
  - `src/utils/viewportImage.ts` —— C2 RAW-only 规则：无 JPG 的 RAW 分组 `src` 必须为 `null`，**不回落 `.NEF`**
  - `src/hooks/useZoomPan` / `useDualZoomPan` —— 绝对系拖拽，抓取偏移存 ref
  - `src/hooks/useViewportImage`
- hooks 内部直接调 `useToast()` 是既定模式，不要往上传回调。

### 导出域规则（2026-10 UX 审计后固化，见 `.plan/export-ux-audit-2026-10-17.md`）

- **两条硬约束**：部分失败绝不伪装成功（`role="alert"` vs `role="status"` 是语义分工）；**取消 ≠ 失败**。
- **live region 独占**：进度条独占 `[aria-live="polite"]`；静态说明用 `aria-describedby`，不要再声明 `aria-live`。
- **disabled 按钮不可聚焦**：挂在它身上的 `title` / `aria-describedby` 键盘与读屏都拿不到。给禁用按钮的解释必须**常驻画在屏幕上**（footer 状态区），不能只放 title。
- **组 ≠ 文件**：`candidates` 数照片组；`exported` 按文件 +1（`export.rs`）。复制模式 1 组 = RAW + XMP + JPG 最多 3 个文件。前端口径真值是 `useExportForm` 的 `expectedFileCount`，改后端复制逻辑时必须同步。
- **`flag` 与 `rating` 是独立字段**（`CullFlag = 'none'|'pick'|'reject'`）。任何按 rating/类型筛的范围档都必须带 `flag !== 'reject'` 守卫——淘汰是删除意图，绝不能换个档位被导出。
- **原子覆盖**：`fs::rename` 在 Unix 是 `rename(2)`、Windows 是 `MOVEFILE_REPLACE_EXISTING`，都原子替换已存在目标，无空窗。覆盖开关默认 `false`；Rust 命令用 `overwrite: Option<bool>` + `unwrap_or(false)`，老前端不传保持旧行为。
- **清单兼容**：`ExportManifest` 新增字段一律配 `skip_serializing_if`（bool 用自写的 `is_false`，`std::ops::Not::not` 收值不收引用会类型不匹配）。`EXPORT_MANIFEST_NAME = ".gallery-export.json"` 前后端两处定义必须一致。
- **打开目录用 `open_folder_cmd`（opener 插件）**，不要走 `cmd /c start "" <path>`——路径含 `&` / `^` 会被 cmd 重新解析。

## 4. 环境坑（每个都真实踩过）

- **WebView2 崩溃红线（踩过两次：10-15、10-17）**：`main.rs` 只在 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` **未设置**时才写 `--in-process-gpu`。任何地方裸 set 这个变量都会把它抹掉 → GPU 子进程 STATIC_INIT 连崩 → 浏览器进程自杀 → 白屏 + `msedgewebview2 has stopped working`。加参数**必须**走 `e2e/lib/app.mjs` 的 `webviewArgs()`（显式前置 `--in-process-gpu`）。
- **e2e 只有应用内驱动这条路能跑**：本机 WebView2 CDP 只服务第一个请求，`e2e/run.mjs`（Playwright）的 `appPageReady()` 永远 false，只会白等超时。真窗口用例走 `npm run e2e:render` / `e2e:preset`（`e2e/run-inapp.mjs` + `src/devtools/e2eRunner.ts` + Vite `/__e2e_log`）。
- **vitest Windows pool 竞态**：必须 `--pool=vmForks`（`vitest.config.ts` 有注释）。
- **clippy 的 "error deleting lock file 拒绝访问 (os error 5)" 是 incremental 锁环境噪音**，不是 lint。判断干净要先 grep 掉它，再看有无源码告警。
- **Rust `#[tauri::command]` 宏不随 glob 导入传递**：`lib.rs` 的 `generate_handler` 必须写 `commands::xxx_cmd` 限定路径；子模块宏要在 `commands.rs` 逐个显式转发（含 `__cmd__` 与 `__tauri_command_name_` 符号）。
- **子模块命名避让**：`xmprw`（不叫 xmp）、`lumencmds`（不叫 lumen）。
- **Tauri v2 ACL**：`core:window:default` 的 28 项权限**不含** `allow-destroy` / `allow-close`。前端 `preventDefault()` 后调 `appWindow.destroy()` 必须在 capabilities 里显式授 `core:window:allow-destroy`，否则窗口被拦住且永远关不掉。jsdom mock 抓不到这类问题，只能真窗口验。
- **Tauri 命令参数即 IPC 契约**：参数多了触发 `too_many_arguments` 时加 `#[allow]` + 注释，不要为闭嘴去拆结构体（会连带改前端调用形状）。

## 5. Commit 与发布

### Commit message

- 格式 `type(scope): 中文摘要` + 正文（`ADD:` / `FIX:` / `CHANGE:` / `DOCS:` 分节），参考 `git log`。
- 提交前全量验证（见红线 1），push 前确认 `git status` 干净。

### 发布流程（v2.0.1/v2.0.3 实证）

1. 版本号改两处：`package.json` + `src-tauri/tauri.conf.json`（`Cargo.toml` 的 lib 版本恒为 1.0.0，**不跟随**）。版本约定 `vX.Y.Z`。
2. bump 提交并 push。
3. 签名构建（thin LTO 首编约 12 分钟）：
   ```bash
   RELEASE_NOTES="$(cat notes.txt)" node scripts/release.mjs
   ```
   `RELEASE_NOTES` 会写进 `updater.json` 的 `notes`（客户端更新弹窗文案），缺省为「🚀 应用有新版本发布啦！」。
4. 提交 `updater.json`（仓库根，tracked）并 push——**老客户端读 master 的 raw 地址，推上去即触发更新弹窗**。签名私钥 `updater.key`（gitignored）。
5. 打 annotated tag，**指向 updater.json 的提交**，message = 版本号：
   ```bash
   git tag -a v2.0.3 -m "v2.0.3" && git push origin v2.0.3
   ```
6. 创建 Release，资产**只传 NSIS setup.exe**（MSI 不传）：
   ```bash
   gh release create v2.0.3 --verify-tag --notes-file release-notes.md \
     "src-tauri/target/release/bundle/nsis/gallery-culling_2.0.3_x64-setup.exe"
   ```

## 6. 文档索引

| 文件 | 内容 |
|---|---|
| `.plan/export-ux-audit-2026-10-17.md` | 导出 UX 审计：14 条 finding、评分 6/10、修复依据 |
| `.plan/execution-log-2026-10-14.md` | 16-18 节是 FE-03b/FE-06/FE-07 全程记录 |
| `.plan/remediation-verification-ledger-2026-10-13.md` | 62 项逐条裁决台账 |
| `.handoffs/` | 交接文档 |
| `e2e/README.md` | e2e 双体系说明（为何只有应用内驱动可用） |

## 7. 工作习惯

- 改前先读相关文件的现状与注释——本项目注释密度高，多数「为什么」都写在代码旁边，别靠猜。
- 修 bug 前先确认测试网：没有能红的用例就先补，再修。
- 新增行为同时更新四档测试里对应的那几档；Rust 侧新命令至少一条集成式单测（真文件系统 tmpdir，不用 mock fs）。
- 语义化中文文案：错误提示要给「下一步怎么办」，不要只报状态码。
