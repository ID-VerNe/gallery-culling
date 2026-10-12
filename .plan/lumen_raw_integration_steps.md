# LUMEN RAW 集成 · Step-by-Step 实施计划

- **日期**: 2026-10-11（基于 6 个并行子代理的 file-by-file 代码比对）
- **宿主**: gallery-flask（Gallery Culling）— Tauri 2.0 + Rust + React 19，MIT
- **客体**: lumen-raw 1.6.0（commit `43b4ebe`，v1.6.0）— Python 非破坏性 RAW 编辑器，MIT
- **上游文档**:
  - `.plan/research/A-cli-bridge-comparison.md` — CLI/MCP/命令层 ↔ Rust 桥接层（500 行）
  - `.plan/research/B-render-pipeline-comparison.md` — 解码/渲染 pipeline ↔ 缩略图/大图预览（490 行）
  - `.plan/research/C-xmp-ratings-comparison.md` — XMP 读写与评级系统（513 行）
  - `.plan/research/D-packaging-comparison.md` — 打包/构建/发布链（467 行）
  - `.plan/research/E-ai-masks-lens-comparison.md` — AI/蒙版/镜头校正（906 行）
  - `.plan/research/F-frontend-ux-comparison.md` — 前端/UX 集成面（497 行）
  - `.glue/deep/integration-plan.md` — glue-engineer deep-mode 总方案（本文是它的**可执行化**）
- **本文定位**: 一切结论以 6 份比对报告为准；报告之间冲突时以"有行号证据者"为准。**每步 = 可独立验证的动作 + 验收标准，不过不进下一步。**

---

## 1. 对上一版计划（lumen_raw_integration_plan.md）的事实修正

逐一比对后，以下 8 条与初版判断不一致，**以本文为新准**：

| # | 初版说法 | 实测（行号证据） | 影响 |
|---|---|---|---|
| 1 | "宿主整文件重写会抹掉 lumen 的 recipe" | **lumen-raw v1.6.0 根本不写任何 `lumen:` XMP 命名空间**（全库 XMP 写入仅 `catalog.py:428-429` 的 `xmp:Rating`/`xmp:Label` 两处；调色在 `.lumen` 工程文件，不碰侧边栏） | XMP 破坏风险**真实存在但来源是 Lightroom**（`lr:hierarchicalSubject`/`dc:subject`/GPS/其余 80+ `crs:*`），不是 lumen；修 `xmp.rs` 的必要性不变，理由改为"与 Lightroom 互操作 + lumen 读 -1 语义" |
| 2 | "reject 映射写 `xmp:Label=Red`" | 客体约定 `Rating=-1`（`catalog.py:425`，Lightroom 惯例）；宿主读取端把 `-1` 裸扫成 **1 星**（`xmp.rs:71-81`） | 宿主读侧有真 bug：按了 reject 的照片重启后显示 1 星；必须修（§5 步 3.3/3.4） |
| 3 | "Qt 懒导入补丁 2 处" | **3 处**：`session.py:108`（→lens_panel）、`commands.py:549` 与 `commands.py:583`（→batch_export） | 补丁与"无 Qt 冒烟"验收要覆盖第三处 |
| 4 | "sidecar 走独立更新通道" | D 报告结论：**不上独立更新器**（onefile 下独立通道无带宽收益，还引入自覆盖风险）；用方案一：随主 NSIS 包 + 模型按需下载 | updater 零改；`release.mjs` 只在 `:30` 前加 sidecar 门禁 |
| 5 | "**预览图走 base64 过管道**" | A 报告：统一走 `output=` 落盘（`render.preview` 带 output 参数，`commands.py:533-534`），宿主**不引 base64 crate**，前端 `convertFileSrc` 是唯一取图路径 | 少一个依赖；协议侧必须传 output |
| 6 | "网格也用 lumen 渲染" | B 报告：网格默认保留 EXIF 内嵌预览（快、相机显影）；**仅检视大图走 lumen**；`thumbnail_engine` 设置项做可选项，且 sidecar 每张 1600px 常驻 ~20MB、**无淘汰** → 32 张/700MB RSS 触发重启 | 内存预算与网格策略写进步骤（§4 步 7、§5 步 2.4） |
| 7 | "recipe 调色 UI 直接透传" | F 报告：① `exposure` 三处范围不一（UI -3/注释 -5/lumen 无约束）→ 统一 -5..+5；② **temperature 量纲未闭环（绝对 K vs 相对偏移）→ 禁止透传**（只透传另外 5 个滑杆） | 步 4.x 有产品决策点，未闭环不开色温同步 |
| 8 | "E 键留给 AI 增强" | F 报告：`E` 键已被调色面板占用（`useKeyboardShortcuts.ts:224-230`） | AI 增强改 **`Shift+E`**；`G` 键空闲，给"套用当前调色预览" |

---

## 2. 总体架构（3 通道 hybrid）

```
React UI（PreviewViewport / TonalAdjuster / 评级栏 / TopBar 徽标）
   │ invoke()
   ▼
src/services/api.ts（+ useLumenPreview / useLumenStatus 两个新 hook）
   ▼
Tauri commands（commands.rs 追加，lib.rs:23-38 generate_handler! 注册）
   ▼
src-tauri/src/lumen_bridge.rs（新增）
   ├─ [A] MCP stdio 常驻 ──► `lumen-cli mcp --headless`   预览主循环（render/get/apply）
   ├─ [B] one-shot spawn ──► `lumen-cli run <cmd> <json>` 评级同步/AI 增强/export 重活
   └─ [C] 命名管道（P2，可选）──► `\\.\pipe\lumen-raw-control-<user>`（运行中的编辑器）
```

铁律：
- **--headless 写死**（`cli.py:158-159`）：避免 MCP 误连本机 GUI（`mcp.py:73-80`），保证行为可复现；
- **所有请求显式带 path**（`session` 每进程全新，`session.py:24-32`）；
- **A 通道一条连接同时只允许 1 个 in-flight**（`control.py:96-105` 无 id 校验，官方也是连-发-读-关）；
- 宿主 SQLite/UI 是选片状态唯一真值，lumen 侧状态只在显式调用时同步。

---

## 3. Step 0 — 契约冻结与 lumen 工作副本（不动宿主代码）

| 步 | 动作 | 落点 | 验收标准 |
|---|---|---|---|
| 0.1 | 引出 lumen **工作副本**（两仓库只读铁律）：`git clone <remote> ..\lumen-sidecar`，钉 commit `43b4ebe` | 仓库外目录 | `git rev-parse HEAD` = `43b4ebe`；`.plan/research/lumen-slim.patch` 按 D 报告 §6.0 三处改动打好（lens_panel→lens.py 迁位 + session.py:108 + batch_export 去 Qt 覆盖 commands.py:549/583） |
| 0.2 | headless venv：`py -3.12 -m venv` → 装 D 报告 `requirements-cli.txt`（directml flavor：`onnxruntime-windowsml`+`windowsml` + numpy/opencv-headless/Pillow/rawpy/tifffile） | `..\lumen-sidecar\.venv` | `python -c "import PySide6"` **必须 ImportError**；`python -c "import onnxruntime as o; assert 'DmlExecutionProvider' in o.get_available_providers()"` |
| 0.3 | import 冒烟（D/E 共用）：`lumen.cli/commands/session/engine/lens` 全 import OK | `..\lumen-sidecar` | 无 PySide6 环境 import 全通过 |
| 0.4 | **冻结命令契约**：`lumen-cli commands > commands.json` | 存 `.plan/research/commands-frozen.json` | 27 条命令 / 24 个 tool 名 / 3 条 tool=null（`library.read_xmp`/`write_xmp`/`import_lightroom`，A 报告 §3.1）；与 A 报告表**逐条零差异**，有差异先停下更新契约 |
| 0.5 | `lumen-cli --version` = `LUMEN RAW 1.6.0`；`lumen-cli mcp-config json` 记录 spawn 参数（黄金参照） | — | 版本串匹配；mcp-config 输出归档 |
| 0.6 | 手测渲染契约（B 步 1）：`lumen-cli run render.preview '{"path":"<CR2/ARW 样张>","size":1600,"output":"<tmp>.jpg"}' --headless` | 样张 | exit 0；JSON `width/height/mime=image/jpeg`；output 文件存在、长边 1600；竖拍样张方向正确（rawpy `user_flip=None` 已转正，**宿主侧不得再 apply_orientation**） |

---

## 4. 阶段 1 — B 通道单发先跑通价值（零新依赖）

> 目标：不写常驻进程，先把"RAW 真预览"做出价值闭环。错误映射句式照抄 `luminar.rs`。

| 步 | 动作 | 落点 | 验收标准 |
|---|---|---|---|
| 1.1 | `find_lumen_cli()`：五级查找（设置项显式路径 → `%LOCALAPPDATA%\Programs\LUMEN RAW\lumen-cli.exe` → `%PROGRAMFILES%` → `where lumen-cli` → 源码树 `<exe> main.py --cli`） | `lumen_bridge.rs` 新函数，仿 `luminar.rs:6-59` 逐级降级 | 5 个 case 单测各返回预期；全失败文案为中文且含"未检测到"（仿 `luminar.rs:64`） |
| 1.2 | `run_lumen(cmd, args)`：`Command::new(exe).args(["run", cmd, &args.to_string(), "--headless"])` + `spawn_blocking` 包 `output()` | 同上 | exit 0 → `serde_json::from_slice` OK（stdout 美化缩进无碍）；exit 1 → 错误串取 `lumen-cli: ` 内容 + 中文前缀；exit 2 → 明确报"参数错误（宿主 bug）" |
| 1.3 | `lumen_preview_cmd(file_path, width=1600, original=false)`：缓存 key=`sha1(lumen-v1｜1.6.0｜abs(src)｜src_mtime｜兄弟.lumen_mtime｜width｜variant)`（B 报告 §3.4；`.lumen` mtime 必须纳入，session 会自动拾取工程）→ 未命中写 `app_cache/lumen/<hash>_lumen.jpg`（**先 .tmp 再 rename**，`create_dir_all` 先行）→ 调 `render.preview` 带 `output=` → 返回**本地路径** | `commands.rs` + `lib.rs` 注册 + `models.rs` 返回类型 | ① 20MP ARW 1600px 渲染 < 1s（CPU，无 GPU）；② 二次同 key < 50ms 不碰进程；③ 触摸 `.lumen` mtime → key 变、重新渲染；④ 旧 `get_thumbnail_cmd` 既有用例零变化 |
| 1.4 | 评级/旗标穿透（B/CLI 语义验证用）：`run_lumen("library.rate", …)` 单测 | `lumen_bridge.rs` | `catalog.jsonl` 尾新增行；二次同值返回 `changed: []` 幂等；**只依赖 `changed` 键**（headless 不返回 photos） |
| 1.5 | 前端：`api.getLumenPreview/getLumenStatus`（camelCase 键 + `\|\| null`，`convertFileSrc` 收口） | `api.ts` + `types/index.ts` | `npx tsc --noEmit` 零报错；invoke 名与 Rust 注册名逐字一致 |

---

## 5. 阶段 2 — A 通道常驻主循环（预览/调色主路径）

> 目标：把 1.3 的单发换成常驻 MCP，做到"翻页 0 冷启动"。`luminar.rs` 是一次性 spawn 先例，常驻管理（supervisor）是净新增代码。

| 步 | 动作 | 落点 | 验收标准 |
|---|---|---|---|
| 2.1 | `LumenState(Mutex<Bridge>)` + `Bridge{child, stdin, next_id, tools, version}`：spawn `lumen-cli mcp --headless`，stdout/stderr 各自 piped；stdout 读线程逐行 → `mpsc::Sender`；stderr 环形缓冲（供 `lumen_logs_cmd` 排错） | `lumen_bridge.rs` + `lib.rs` `.manage(LumenState::new())` | 关 stdin 后子进程 1s 内自行退出（`mcp.py:102-104`，证明能干净回收）；stderr 不污染协议流 |
| 2.2 | JSON-RPC legacy 客户端：`request(method, params)` 写行 + flush + `recv_timeout` 读行；**宿主自己严格校验应答 id**（不照抄 `control.py:99-105`） | 同上 | `initialize{protocolVersion:"2024-11-05"}` → `serverInfo.version=="1.6.0"`（断言不符即禁用 RAW 链路 + 中文提示）；`ping→{}`；坏 JSON 收 `-32700`；未知方法收 `-32601` |
| 2.3 | `tools/list` 缓存 + `call_tool`：解析序 `error` → `result.isError` → `content[].text`（业务错走 isError，不是 JSON-RPC error） | 同上 | 工具数 = 25（24+run_command）；故意传未知键 → isError + text 含 `unknown argument(s)`（双错误通道都识别） |
| 2.4 | 主循环切 A：`render_preview{path,size,output}`（**永远带 output**，不引 base64）+ `get_edits{full:true}` + `apply_edits`；`Cargo.toml` tokio features 评估：建议纯 std + `spawn_blocking` + `sync`（与 luminar 风格一致），不引 async 管道 | `lumen_bridge.rs` | ① 会话粘性已知化（current photo 会漂移，命令全显式带 path）；② `get_edits.changes` 是"相对差"语义（`commands.py:185-187`），写回用最终值 |
| 2.5 | 超时与重连：preview 60s / enhance 600s（对齐 `ai_worker.RUN_TIMEOUT=600`）/ 其他 120s；超时或读线程 EOF → Dead → 指数退避 0.5s→8s 重启 → 重跑 2.2/2.3；重启期间命令返回"正在重连" | 同上 | 手动 taskkill sidecar → 下一次操作自动恢复不白屏；连续 5 次崩溃仍恢复且退避 ≤8s |
| 2.6 | 内存预算：sidecar 每 1600px 常驻 ~20MB 且无淘汰 → 达 32 张或 RSS≈700MB → 自动重启（记 session 外无状态，重启无损失） | 同上 | 连续翻 32 张 RAW 后 RSS 抽样 ≤ 预算；翻页不因重启报错 |

---

## 6. 阶段 3 — XMP 合并修复 + 评级互通（闸门：先修 xmp.rs 再谈 recipe）

> 目标：宿主写真不再毁第三方标签；评级双向同步；评级映射唯一化。依据 C 报告 §5-§8。

| 步 | 动作 | 落点 | 验收标准 |
|---|---|---|---|
| 3.0 | **先写红测试**：手工构造含 `<lr:hierarchicalSubject>`/`<dc:subject>`/GPS 的侧边栏 → 调 `write_xmp` → assert 存活 | `xmp.rs` tests | 当前**必须红**（证明问题存在） |
| 3.1 | `roxmltree = "0.19"` 引入 + `ours_namespaces()`（4 个 URI：xap/1.0、exif/1.0/aux、exif/1.0、camera-raw-settings/1.0） | `Cargo.toml:27-37` / `xmp.rs` | 单测：Lightroom/ExifTool 侧边栏中各 ns 判定 OURS=false，本方=true |
| 3.2 | `read_xmp_full` DOM 化：删 `extract_tag_value` 裸解析，新 `tag(doc, ns, local)` | `xmp.rs:37-109` | `Rating=-1` → `rejected=true`（新字段）；`Label=红色` 返回原文；修掉 `find("exif:FocalLength")` 子串误匹配 |
| 3.3 | `write_xmp_full` → `merge_xmp(existing, meta)`：DOM 解析 → 删本方 Description → 本方节点插 RDF index 0 → **xpacket 区间原位替换**（roxmltree 只读无写回，通用序列化会破坏向后兼容） | `xmp.rs:118-206` | 步 3.0 测试**转绿**；无旧文件时输出与今天模板**逐字节一致**（fixture 比对，C §5.4 五条不变量） |
| 3.4 | reject 语义：写 `Rating=-1` + 清 `Label`（不再写 Label=Red） | `xmp.rs:209-219` | 单测等价断言 `_fields_from_tags` 语义（`catalog.py:366-377`） |
| 3.5 | 映射合一：`scanner.rs:307-311` 与 `:380-384` 两处重复映射抽到 `xmp.rs::flag_from_xmp(label, rejected)`，rejected 参与判定 | `xmp.rs`/`scanner.rs` | 9 种组合参数化单测；grep 确认 scanner 无 `"Green" => "pick"` 残留 |
| 3.6 | `rating_sync` 游标表（宿主无评级时间戳，增量只能记账）：`photo_path PK / rating / flag / source(host\|lumen) / sidecar_mtime / synced_at` + `upsert/lookup/mark_source/list_dirty` | `db.rs:17-36` | dirty 判定：值变了或侧边栏 mtime 变了才 dirty；二次同步全命中零 spawn |
| 3.7 | export（宿主→lumen）：挂 `update_rating_flag_cmd`（`commands.rs:40-55`）内 `write_xmp` 后 push；`RatingQueue` 200ms 去抖，按 flag 分组 batch spawn（400 路径/批，Windows CreateProcess 32KB 限制）；**rating=0 只写真不推**（lumen compact 会压掉全零 entry） | `lumen_bridge.rs` | 按 `3`+`P` → `lumen-cli list folder:<dir>` 显示 rating=3 flag=pick；catalog.jsonl 有带 `t` 记录 |
| 3.8 | import（lumen→宿主）：`scan_folders` 后 `list_ratings(dir)`（`library.list` 显式 `limit:5000`，命令 id 走 run_command，**不用 `xmp read`**——那只能写真，拿不到 catalog 真值）→ merge + rating_sync 记账 | 同上 | lumen 里打 3 张星（不开 library_xmp）→ 宿主刷新 → 3 张卡显示星级；再刷一次 0 spawn |
| 3.9 | 冲突裁决：`source` 位 + 侧边栏 mtime（`lumen-cli list` 不带 `t`，拿不到客体时间戳）；真 ambiguous → 列 UI 人工裁决，**绝不静默覆盖** | 同上 + Conflict UI | 两侧同改一张 → Conflict{host,lumen} 返回前端；裁决后 source 更新 |
| 3.10 | Lightroom 导入**借道**：`import_lightroom_cmd` → `library.import_lightroom` + 一次 pull（不移植 60 行 SQL，一份实现） | `commands.rs` | mock/真 `.lrcat` → imported=N，虚拟拷贝被跳过 |

---

## 7. 阶段 4 — 前端 UX 与 recipe 互通（F 报告步 1–11）

| 步 | 动作 | 落点 | 验收标准 |
|---|---|---|---|
| 4.1 | `useLumenStatus.ts`（启动 1500ms 后握手，不阻塞首屏）+ `LumenStatusBadge.tsx`（三态：绿=sidecar 就绪 / 灰=不可用 / 不渲染=lumenEnabled=false）；TopBar :262 插 slot | `src/hooks`、`src/components`、`TopBar.tsx`、`App.tsx:680` | 未配置 → 灰 + title 文案 T1；配置后徽标进设置保存返回 → 绿；disabled 时零 `lumen_*` invoke |
| 4.2 | `useLumenPreview.ts`：RAW_ONLY 且 available → `lumenRenderPreview(raw.path, 1600)`；`attemptsRef` 限失败次数；降级 `toAssetUrl(raw.path)`；**URL 缓存按 group.id 失效**（防串图回归 F-03） | `src/hooks` | 四种输入（JPG 组 / RAW_ONLY+可用 / +不可用 / 切 group）输出正确 |
| 4.3 | `PreviewViewport.tsx:132-136` 改走 hook；:179 前 loading 分支；`onError` 回落；**:187 filter 在 lumen 渲染成功时强制 `'none'`**（防二次显影，B §6.3） | `PreviewViewport.tsx` | ARW 单图显示真实解码预览；渲染超时不叠加 filter；杀 sidecar 翻页不白屏不弹 toast |
| 4.4 | `SettingsModal` 引擎块（:124 后）：启用开关 / sidecar 路径（browse 仿 :34-44 exe 过滤）/ 网格引擎 exif\|lumen / 手动同步按钮 / 握手状态行（available+backend+version 三元组） | `SettingsModal.tsx` | 保存→重启→`getSettings` 带回新字段；`lumenEnabled=false` 时零请求；填错路径 → 徽标灰无未捕获异常 |
| 4.5 | `utils/toneToRecipe.ts` 纯函数 + **exposure 统一 -5..+5**（改 `TonalAdjuster.tsx:49-50` 与 types:27 注释）；**temperature 在量纲闭环前不透传**（只透传 5 个滑杆 + UI 注明） | `src/utils`、`TonalAdjuster.tsx` | 6 字段往返单元测试（tone→recipe→tone 恒等）；exposure ±5 不夹断 |
| 4.6 | `TonalAdjuster` 保存按钮按 `lumenStatus.available` 切 label（"同步 XMP" ↔ "套用到 LUMEN RAW"）+ `onSaveXmp` 落点分支；不可用时仍写 crs:* XMP（Lightroom 兼容不回归） | `TonalAdjuster.tsx:225-240`、`App.tsx:570-593` | 两个分支都验证；不可用时点击行为与今天逐像素一致 |
| 4.7 | `BeforeAfterViewport` 前后对照**同源**：before=无 recipe 渲染（`original=true`），after=带 recipe 渲染；:118-119 filter 同步处理 | `BeforeAfterViewport.tsx` | 左右同源同尺寸（不是"内嵌 JPEG vs lumen"）；无 recipe 时行为不变 |
| 4.8 | `ThumbnailGrid` L 角标（`.lumen` 存在）+ legend + 屏幕阅读器文案；`G` 键（"套用当前调色预览"，P1 注册）+ ShortcutHelp `buildGroups(lumenAvailable)` | `ThumbnailGrid.tsx`、`useKeyboardShortcuts.ts`、`ShortcutHelpModal` | G 可用时渲染并切 Y 视图；不可用时按 G 无反应且帮助面板无该行；帮助面板与实际注册零死键 |
| 4.9 | 评级同步挂载：`handleRate:443`/`handleFlag:465` try 内加 `api.lumenSyncRatings`（Option B 单发），失败走独立 error 通道**不混入 XMP toast 文案**（乐观更新不回滚） | `App.tsx` | Gallery 打星 → lumen 同目录立可见；同步失败 toast 指向"检查 lumen 安装" |
| 4.10 | 宫格引擎开关分流（默认 exif）：`ThumbnailGrid.tsx:374-387` 按设置走 `getLumenPreview(path,200)`；sidecar 重启策略随之生效 | `ThumbnailGrid.tsx` | exif 模式性能零回退；lumen 模式 200 张首轮 < 400ms/张 |

---

## 8. 阶段 5 — sidecar 瘦身构建与宿主打包（D 报告）

| 步 | 动作 | 落点 | 验收标准 |
|---|---|---|---|
| 5.1 | `LumenCLI.spec`（基于 LumenRAW.spec 35 行 diff：只留 cli 入口；剔 PySide6/Qt/字体/9 语言/语音；留 lumen 包+rawpy+numpy+opencv-headless+tifffile+onnxruntime-windowsml+lensfun 数据；**排除 assets/models/*.onnx 与 assets/exiftool**） | `..\lumen-sidecar\LumenCLI.spec`（D §2.2） | review diff 与 D 报告保留/剔除清单一致 |
| 5.2 | 构建三连验收：`pyinstaller --noconfirm --clean LumenCLI.spec` | `src-tauri/binaries/lumen-cli.exe`（onedir 则连 `_internal/`） | ① **无 Qt**：`Get-ChildItem -Recurse -Include Qt6*.dll,PySide6*,shiboken6*` → **0 行**（硬门禁）；② 体积：onefile < 120MB，**>130MB 触发 onedir 回退**后 `_internal` 合计 < 120MB，仍超则上报 ORT flavor 决策；③ 数据完整性：`assets/lensfun/db/slr-canon.xml`、`assets/models/selection-models.json` 在，`*.onnx`、`assets/exiftool/*` 不在 |
| 5.3 | Tauri 装配：`tauri.conf.json` bundle 加 `resources:["binaries/lumen-cli.exe"]`；`lumen_cli.rs` 用 `app.path()` 定位 + `std::process` spawn（**不引 shell 插件**，capabilities 不改） | `src-tauri/tauri.conf.json:40-51`、`lumen_cli.rs` | `pnpm tauri dev` 能起；宿主 spawn `lumen-cli --help` 读到 stdout |
| 5.4 | `package.json` scripts 加 `build:lumen`（→ 宿主侧 `build_lumen.ps1`：venv→依赖→PyInstaller→copy 到 binaries）；`release.mjs:30` 前插 sidecar 门禁（打印 `📎 sidecar: lumen-cli.exe xx.xMB`）；updater.json 不动 | `package.json`、`scripts/release.mjs` | `pnpm release` 一次通过，stdout 含 sidecar 体积行与 NSIS 体积行 |
| 5.5 | 干净目录冒烟（**禁用客体 `--smoke-test`**，它要完整 AI 模型）：`lumen-cli --help` / `info <jpg>` / `render <jpg> out.jpg` 三条 exit 0 | `$env:TEMP\clean-room` | 三条全 exit 0；out.jpg size>0 |
| 5.6 | 资产按需下载器：ExifTool+权重从 lumen 硬编码 `_internal/assets` 的实际结构出发 → 下载到 `%LOCALAPPDATA%\gallery-culling\lumen-assets\`（sha256 校验，原子 rename，manifest 复用 `assets/models/*.json`）→ **junction 进 sidecar 解压目录**（onefile 是 `%TEMP%\_MEI*`，onedir 是 `_internal`） | `lumen_models.rs`（E §6.3） | 首次用 `info <raw>` 触发下载；二次不重下；改 1 字节 → 重下还原；断网 → 明确错误不留 .tmp |
| 5.7 | 合规：`THIRD-PARTY-NOTICES.txt` 生成（lumen MIT / rawpy-LibRaw LGPL-2.1+CDDL / lensfun CC BY-SA 3.0 / 权重逐项 / ExifTool Artistic / **排除 SenseVoice**）；`dumpbin /imports` 抽查 rawpy 动态链接 | 仓库根 | CI 门禁：notices 存在且 LibRaw 条目含源码获取途径；抽查无静链 |

---

## 9. 阶段 6 — AI 蒙版 / AI 增强 / 镜头校正（P2，E 报告）

| 步 | 动作 | 落点 | 验收标准 |
|---|---|---|---|
| 6.1 | 蒙版最小模型集按需下载：`u2netp.onnx` 4.36MB + `skyseg.onnx` 167.84MB（共 ~172MB，P1 蒙版就绪即用，不等到 P2） | `lumen_models.rs`（复用 5.6） | junction 后 `<sidecar>/_internal/assets/models/skyseg.onnx` Get-Item 显示 LinkType: Junction |
| 6.2 | **AI 蒙版核心验收**：`lumen-cli run edit.apply '{"path":"<sky.CR2>","changes":{"masks":[{"region":"sky","adjustments":{"exposure":-0.6,"saturation":15}}]}}' --headless` | 样张 | ① 返回 `notes` 为**空数组**（含 `sky: ...` = 模型缺失/provider 失败，须排查，E §3.3——静默吞错要透传）；② `edit.get full=true` → `recipe.masks[0]` 含 `kind:"sky"`、raster>1000 字符、`feather:10`；③ 视觉对比 original=true 天空压暗、地面不变；④ `gpu-compat.json` 不存在（不存在 GPU 原生崩溃记录） |
| 6.3 | 多 region + 上限语义：一次请求 5 个新 region → `notes` 含"一次最多新增 4 个蒙版"且不中断；MCP 通道同链路（`apply_edits`+`render_preview`） | 宿主 | tools/list 有 `apply_edits`/`render_preview`；state.masks=2 且 kind=sky/linear |
| 6.4 | worker 隔离与崩溃降级：`LUMEN_TEST_WORKER_CRASH=skyseg.onnx` 注入 | 样张 | 命令不整体失败，gpu-compat.json 生成且含该模型；再跑正常 sky 自动跳过崩溃 provider 仍出图 |
| 6.5 | `photo.enhance` 补丁（**在 lumen 工作副本**，不入宿主）：`commands.py` 追加 ~55 行 + **`palette.py:27` 必加 1 行**（否则上游 `tests/test_v160.py:560` 断言红）；`cli.py` 逻辑零改 | `.plan/patches/photo_enhance.patch` | `pytest tests/test_v160.py -q` 全绿；`commands` 清单出现 photo.enhance 且参数含 kind/method/scale/amount/folder/gpu；denoise 产 `<stem>-去杂色1.dng`、super 2× 面积×4；原文件 mtime/sha256 不变；缺模型时错误**点名缺失文件**；kind/method 不匹配 → `unknown method N for kind K` |
| 6.6 | 宿主 `lumen_enhance_cmd`（仿 `luminar.rs:129-159` spawn_blocking + 退出码判错，**超时 ≥600s**）+ `AiEnhanceModal` + **Shift+E**（E 键已占用）+ TopBar/PreviewViewport 入口 | `commands.rs`、前端 | 61MP super 4× 可等；可取消（kill 子进程）；DNG 副本被 scanner 认成 edited 角标（需补 `{stem}_Lumen.dng` 候选名，`scanner.rs:17`）；失败 toast 带"模型权重首次需下载" |
| 6.7 | 镜头校正**零代码白拿**：lensfun DB 在 git（5.02MB）随包打包，`lens.correct` 已在 `engine.process:917-919` 主链路 —— 宿主只调 render 即生效 | — | LUMEN RAW 里开"启用配置文件校正"后宿主渲染与编辑器**像素级一致**（<1e-4）；关掉差异集中在四角；安装包只 +5MiB；notices 含 CC BY-SA 条目 |
| 6.8 | 性能与记忆账（中端机 24MP）：sky 蒙版 <3s / FFDNet <20s / NAFNet <60s / ESRGAN x4plus 2× <120s；worker 峰值 <1.5GB；LUMEN_COMPUTE=cpu 兜底仍出图 | 记录 | 表格式记录进验收文档 |

---

## 10. 阶段 7 — 收尾：全量降级回归

| 步 | 动作 | 验收标准 |
|---|---|---|
| 7.1 | 崩坏注入矩阵：lumen 未安装 / 被 kill / 版本漂移（`app.status.version≠1.6.0`）/ 拔掉 sidecar 路径 / 断网（模型下载失败） | 全部 AI/蒙版入口置灰或降级；**选片主流程零影响、零报错弹窗**；徽标/角标/lumenEnabled 组合无异常 |
| 7.2 | lumen 关闭态 vs 集成前基线：逐屏截图 diff | 行为一致（P0 验收等价物） |
| 7.3 | 快捷键终审：`?` 面板、G、Shift+E、C/Y/[ ]/1-5/P/X 无死键无冲突 | 面板文案与实际注册逐字一致 |
| 7.4 | 磁盘账：`app_cache/lumen/` LRU 清理入口（每次渲染落文件）+ "清理模型缓存"入口 | 两处入口可用；清理后自动重下 |
| 7.5 | 文档与契约快照：`.plan/research/commands-frozen.json` 归档；升级 lumen 时**重跑 6 份比对的流程**写入 README/开发文档 | 文档含"lumen 升级 checklist" |

---

## 11. 里程碑与工作量

| 里程碑 | 覆盖步骤 | 预估 | 出口 |
|---|---|---|---|
| M0 契约冻结 | §3（0.1–0.6） | 2–3 天 | 无 PySide6 的 v1.6.0 sidecar 可跑 commands/render |
| M1 RAW 真预览（B→A+前端） | §4 + §5.1–5.3 + §6（4.1–4.4） | 4–6 天 | RAW_ONLY 大图真实解码；冷<3s 热<1s；lumen 关=今天行为 |
| M2 XMP 修复+评级互通 | §5.1（步 3.0–3.6）+ §6（4.9） | 4–5 天 | fixture 逐字节一致；双向评级闭环；0 星规则生效 |
| M3 recipe 互通 | §6（4.5–4.8）+ §5（3.7–3.10） | 3–4 天 | G 键/前后对照同源；冲突 UI |
| M4 发布链 | §7（5.4–5.7）+ §8（7.1–7.5） | 2–3 天 | 安装包 <体积预算；notices；降级矩阵全绿 |
| M5 P2（AI/蒙版/镜头） | §9 全部 | 2–3 周 | photo.enhance 上游 patch 合入或 patch 维护；按需模型 172MB |

## 12. 风险登记（合并 6 报告）

| # | 风险 | 缓解 | 来源 |
|---|---|---|---|
| R1 | sidecar 体积 >120MB（onnxruntime-windowsml 60–90MB 是唯一变量） | "无 Qt + 实测体积"双门禁；超标 → onedir 回退 → CPU flavor 上报 | D |
| R2 | session 常驻无淘汰，200 张网格 = 4GB | 32 张/700MB 重启；网格默认 exif 档 | B |
| R3 | render.preview 源上限 1600 | 文档化；>1600 走 `lumen-cli render` 单发 | B |
| R4 | MCP 误连本机 GUI | `--headless` 写死 | B/A |
| R5 | rating=0 推 lumen 会被 compact 压掉 | 0 星只写真不推 | C |
| R6 | temperature 量纲放大数百倍 | 未闭环前不透传 | F |
| R7 | E 键冲突 | Shift+E | F |
| R8 | 模型缺失被静默吞（notes 里不显眼） | 宿主必须透传 notes；下载器点名缺失文件 | E |
| R9 | ORT/windowsml TRT 首次自动下载（TRT-catalog） | 验收记录用户无感；必要时评估 directml 单 provider 版 | D |
| R10 | 920 行 AppShell 上下文漂移（F-01…F-25 历史） | 新状态全进独立 hook，App.tsx 只加挂载点 | F |

## 13. 附录 — 协议速查（实现时对照 A 报告全文）

```
# A 通道（常驻，newline-delimited JSON-RPC 2.0，无 Content-Length）
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05",...}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"render_preview",
  "arguments":{"path":"D:/x.CR2","size":1600,"output":"<app_cache>/lumen/<sha>.jpg"}}}
# → content[0].text = json.dumps(result)；result.image 只在未传 output 时存在 → 一律传 output

# B 通道（单发）
lumen-cli run library.rate  '{"rating":3,"paths":["D:/a.CR2","D:/b.CR2"]}' --headless   # 200ms 去抖
lumen-cli run edit.apply    '{"path":"D:/a.CR2","changes":{"masks":[{"region":"sky","adjustments":{"exposure":-0.6}}]}}' --headless
lumen-cli run library.list  '{"query":"folder:D:/shoot","limit":5000}' --headless         # import 用（catalog 真值）
lumen-cli run photo.enhance '{"kind":"denoise","method":2,"amount":35,"path":"D:/a.ARW"}' --headless  # P2 补丁后
# exit: 0=OK；1=lumen 业务/IO 错误（stderr "lumen-cli: ..."）；2=用法错误（宿主 bug）

# C 通道（P2 可选）：{"id":1,"command":"render.preview","args":{...}}\n → {"id":1,"ok":true,"result":{...}}
```

**lumen 升级 checklist**：换 commit → 重跑 `.plan/research/` 六领域比对（子代理 prompt 以本文 §2 铁律+钉版本替换）→ diff `commands-frozen.json` → 评估 patch 套用 → 验收 §8 崩坏矩阵。
