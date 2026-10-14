# gallery-flask DRY/SRP 拆分审计报告

**日期**:2026-10-13
**对象**:Tauri 2.x 桌面应用(gallery-culling v1.1.1)
**方法**:14 个并行只读 subagent 按文件/领域分片,各自带 file:line 证据与代码片段返回;本报告为合成层
**性质**:只读审计,未修改任何源文件

---

## 0. 审计范围

- **后端**:Rust 10 文件约 8127 行
- **前端**:TS/TSX 约 34 文件 10226 行
- **分片**:scanner.rs+thumbnail.rs / db+models+luminar+lib / App.tsx / hooks+types / commands.rs+xmp.rs(合并)+各自详细 / 三视口 / lumen.rs(1-1600)+(1600-3213) / services+utils / modals+TonalAdjuster / ThumbnailGrid / TopBar+BottomBar+Toast+Modal

---

## 1. 执行摘要

按严重度排序的顶层结论:

| 级别 | 数量 | 代表问题 |
|---|---|---|
| **CRITICAL 正确性/数据丢失** | 4 | xmp.rs reject 分支清空镜头与调色元数据;lumen.rs 未知工具静默映射 app.status;ProcessTransport 把进程崩溃与超时混为同一返回;append_our_block 对畸形 XMP 静默覆盖为空模板 |
| **HIGH SRP 巨石** | 9 | App.tsx(1753 行/37 useState/12+ 领域)、lumen.rs(3213 行/13+ 职责)、commands.rs(1693 行/8 领域/28 命令)、xmp.rs(1168 行/5+ 职责)、SettingsModal(515 行)、三视口(各 600+ 行)、ThumbnailGrid(873 行/9 职责)、TopBar(355 行/11 职责)、Toast(285 行/4 职责) |
| **MEDIUM DRY 重复** | 12+ | 三视口约 445 行可消除;commands.rs Lumen 守卫 11 份、错误转换 20 份;lumen.rs spawn+handshake 3 份;xmp.rs read-modify-write 3 份;modals 异步模式 7 份;跨 6 文件幽灵按钮样式 |

**最重要的一句话**:审计发现 4 条正确性/数据丢失缺陷(非风格问题),其中 xmp.rs 的 reject 路径会在常规操作中静默清空已有镜头与调色元数据,优先级最高。

---

## 2. 严重缺陷:正确性与数据丢失(CRITICAL)

这 4 条不是风格问题,是会产出错误行为的缺陷。

### 2.1 xmp.rs:reject 操作丢弃已有镜头/调色元数据

**位置**:`xmp.rs:413-437`(`write_xmp`)+ `xmp.rs:397-406`(`write_xmp_rating_minus_one`)

```rust
pub fn write_xmp(image_path: &Path, rating: u8, flag: &str) -> Result<PathBuf, String> {
    let xmp_path = get_xmp_path(image_path);
    let mut meta = read_xmp_full(&xmp_path).unwrap_or_default(); // 读到了 lens/tone
    meta.rating = rating;
    meta.label = match flag { "pick" => "Green".to_string(), _ => String::new() };
    if flag == "reject" {
        meta.rating = 0;
        return write_xmp_rating_minus_one(image_path); // 丢弃了已读的 meta
    }
    // ...
}

fn write_xmp_rating_minus_one(image_path: &Path) -> Result<PathBuf, String> {
    let meta = XmpMetadata {       // 全新空壳
        rating: 0, label: String::new(), rejected: true,
        ..Default::default()       // lens_model=None, exposure=None, highlights=None...
    };
    write_xmp_preserving(image_path, &meta)
}
```

`write_xmp` 在 reject 分支读了 `meta`(含镜头型号、焦距、光圈、调色参数),但随后调用 `write_xmp_rating_minus_one`,后者构造全新 `Default::default()` 空壳。第三方命名空间(lr:/dc:/GPS)由 `splice_our_block` 保留,但**本方 our-block 内的镜头和调色数据被清空**。

**影响**:对一张已有镜头和调色数据的照片执行 reject,永久丢失这些元数据。reject 是高频操作。

**修复方向**:reject 分支直接 `meta.rejected = true; write_xmp_preserving(image_path, &meta)`,删除 `write_xmp_rating_minus_one`。

### 2.2 lumen.rs:未知工具静默映射到 app.status

**位置**:`lumen.rs:517-527`

```rust
fn tool_to_command_id(tool: &str) -> &'static str {
    match tool {
        "rate_photos" => "library.rate",
        // ...
        _ => "app.status",  // 未知工具静默兜底
    }
}
```

传入未预期的工具名时不报错,静默映射到 `app.status`,在 B 通道兜底时执行无关命令,产生难以排查的异常行为。

**修复方向**:`_ =>` 分支返回 `Err` 或 panic。

### 2.3 lumen.rs:ProcessTransport 把进程死亡与超时混为同一返回

**位置**:`lumen.rs:401-408`

```rust
Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Ok(None),
Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Ok(None),
```

子进程已崩溃(Disconnected)与子进程只是慢(Timeout)都返回 `Ok(None)`,上游 `McpClient::request`(1289)统一当作 `LumenError::Timeout`。在 `render_preview` 的 B 通道兜底逻辑中,崩溃导致的"超时"会触发一次可能也失败的 `run_lumen` 调用,而非直接重启 sidecar。

**修复方向**:`Disconnected` 返回明确的 `LumenError::Io("sidecar 进程已退出")`,让上层区分"重启"与"重试"。

### 2.4 xmp.rs:append_our_block 对畸形文件静默覆盖为空模板

**位置**:`xmp.rs:385-395`

```rust
fn append_our_block(existing: &str, our_block: &str) -> String {
    if let Some(pos) = existing.find("</rdf:RDF>") { /* 正常插入 */ }
    // 连 rdf:RDF 都没有的畸形文件:直接覆盖为标准模板
    build_fresh_document(&XmpMetadata::default())
}
```

注释说"不冒险改写",但实际行为是用空模板覆盖整个文件内容,且 `Ok` 返回不报错。用户有一个结构不规范的 `.xmp`(手动编辑过、被其他工具写坏),任何一次 `write_xmp` 调用都会把全部内容替换为空白模板。

**修复方向**:返回 `Result` 并在找不到 `</rdf:RDF>` 时返回 `Err("无法在畸形 XMP 中插入块")`。

---

## 3. 后端 Rust 层

### 3.1 lumen.rs(3213 行)—— 最大巨石

**职责计数**:1-1600 行内至少 13 个独立职责,1600-3213 行全部是测试(1614 行)。文件头注释(1-7 行)宣称"不包含常驻 MCP",但实际包含完整 `McpClient`、`ProcessTransport`、`Supervisor`、`LumenRuntime`——注释已失效。

**建议拆分目标**(14 个子模块):

| 职责 | 目标文件 |
|---|---|
| 错误类型 | `lumen/error.rs` |
| 可执行文件发现 | `lumen/discovery.rs` |
| CLI 执行 | `lumen/cli.rs` |
| 缓存键与规范化 | `lumen/cache.rs` |
| 传输层 | `lumen/transport.rs` |
| JSON-RPC + MCP 客户端 | `lumen/protocol.rs` |
| 监督器 | `lumen/supervisor.rs` |
| 蒙版与区域映射 | `lumen/masks.rs` |
| Tone ↔ recipe | `lumen/tone.rs` |
| 评级同步 | `lumen/sync.rs` |
| 能力探测 | `lumen/capabilities.rs` |
| 常驻运行时 | `lumen/runtime.rs` |
| 版本/状态/预览编排 | `lumen/preview.rs` + `lumen/status.rs` |

**DRY 重复点(1-1600 行)**:

| 重复模式 | 次数 | 位置 |
|---|---|---|
| spawn + handshake + 客户端初始化 | 3 | 481-502, 957-963, 1200-1208(后两处逐字一致) |
| 失败重置(client/version/failures)——且不一致:仅 render_preview 设 last_error | 3 | 914-920, 970-976, 1119-1123 |
| `edit.get` 相同调用 | 3 | 1001-1006, 1050-1054, 1069-1073 |
| 锁中毒 `.map_err`——消息不统一("锁中毒"/"运行时锁中毒") | 3+ | 885, 950, 1112, 1193 |
| `["mcp", "--headless"]` 字面量 | 3 | 481, 958, 1203 |
| SHA-256 hex 短编码 | 2 | 262-269, 649-655 |
| content text 块提取链(6 层 and_then) | 2 | 1362-1373, 1377-1387 |
| MAX_RESTARTS 检查——call_rating_tool 缺检查 | 2/3 | 954, 1198(缺 1110) |

**SRP 巨型单元**:`LumenRuntime` impl 块(875-1260)共 385 行含 17 个方法,是真正的 SRP 问题单元(无单个函数超 80 行,但 impl 块过载)。

**疑似死代码**:`Supervisor`(420-504)与 `LumenRuntime`(755-771)都做"跟踪失败次数 + 决定是否重启",`Supervisor` 在 1-1600 行内未被引用。需确认 1600 行之后是否使用,若否则删除,若是则让 `LumenRuntime` 委托它。

**测试段(1600-3213)问题**:
- 进程组装样板(stdin/stdout/stderr + 两条线程 + channel + ProcessTransport 装配)4 份拷贝:2349-2385, 2409-2434, 2468-2496, 2521-2551。根因是 `ProcessTransport` 字段私有、缺少 `from_child` 构造函数,测试只能手动重造
- MCP 握手前两帧脚本 3 处重复:2286-2287, 2304-2305, 2320-2321
- 临时文件清理无 RAII guard,panic 即泄漏(8+ 处手动 `remove_file`),应换 `tempfile::TempDir`
- 疑似源码缺陷:2651-2653、2917-2919 的 raw string 路径被换行打断(`r"C:\nope\..."` 内部出现真实换行),需打开源文件核对原始字节

### 3.2 commands.rs(1693 行)—— 8 领域分发器

**领域分布**:28 个 `#[tauri::command]`,Lumen 占 11 个(39%)、XMP/元数据 3 个、外部应用 4 个、导出 2 个+1 实现体、扫描 2 个、缩略图 1 个、设置/会话 4 个、调色管线 2 个。

**建议拆分**:`commands/{mod,scanner,thumbnail,xmp,apps,export,settings,lumen,tone}.rs`,`AppState` 与共享设施放 `mod.rs`。

**DRY 重复点**:

| 重复模式 | 次数 | 位置 |
|---|---|---|
| Lumen 准入守卫(load_settings→check enabled→find_cli→clone runtime) | 11 | 774-782, 884-915, 996-1005, 1083-1095, 1125-1131, 1153-1159, 1173-1179, 1202-1248, 1288-1305, 1349-1361, 1389-1397 |
| `spawn_blocking.map_err("...任务异常: {}", e)` | ~20 | 153, 175, 220, 247, 324, 553, 793, 854, 973-974, 1074, 1115, 1142, 1162, 1187, 1227, 1267, 1309, 1380, 1400 |
| `open_in_default_app_cmd` 三平台同格式串 | 3 | 287, 295, 303 |

**Lumen 降级策略不一致**(隐性 DRY 违背 + 设计缺陷):同为"引擎未启用",各命令返回不同——读类命令普遍静默降级(`Ok(default)`/`Ok(Vec::new())`),写类命令普遍报错(`Err`),但 `apply_tone_cmd`(写命令)却走"静默+warning"。没有统一守卫 helper,前后端契约只能逐个背。建议守卫 helper 返回枚举,把"读降级/写报错"策略集中。

**SRP 巨型函数**:
- `export_items`(570-692,123 行):目标目录创建 + 同目录自检 + 临时目录 + 遍历复制(4 个取消检查点散落)+ 取消收尾 + 提交搬迁 + 清单写入。取消点漏一个就破坏"取消后零污染"不变量
- `lumen_preview_cmd`(875-982,108 行):守卫 + recipe 解析 + 变体归一化 + 缓存键 + 命中判定 + spawn 渲染 + 结果组装
- `lumen_sync_ratings_cmd`(992-1075,84 行)、`apply_tone_cmd`(1197-1280,84 行):决策表埋在 spawn 闭包里无法独立测试

### 3.3 xmp.rs(1168 行)—— 57% 测试代码

**结构**:生产代码约 497 行(0-497),测试 671 行(498-1168)。5+ 职责:路径计算、XML 解析、XMP 序列化、命名空间归属判定与块替换、文件 IO、评级/旗标业务、调色业务、镜头元数据业务。

**DRY 重复点**:

| 重复模式 | 次数 | 位置 |
|---|---|---|
| read-modify-write 三段式骨架 | 3 | 414-437, 440-459, 462-480 |
| `extract_tag_value + parse::<f32>` | 6 | 102, 104, 106, 108, 116, 118 |
| 命名空间 URI(常量数组 + format 字面量 + match 反查三重定义) | 每个各 3 处 | 144-149 / 258-263 / 338-345 |
| `Option<String> → 条件 format!` tag | 3 | 183-195, 197-208, 210-218 |

**SRP 巨型函数**:`build_our_description`(168-269,101 行)混序列化 + 格式策略,每个字段的 Option→条件 format 手写一遍。建议抽 `optional_str_tag` / `optional_crs_tag` helper,缩到 ~30 行。

**其他**:
- `write_xmp_full`(408-411)是纯透传冗余层,删除
- `read_xmp` 标记 `#[allow(dead_code)]`,若无人调用则删除
- temperature 读取嵌入业务策略(`.filter(|v| (-100.0..=100.0).contains(v))`),解析与策略未分离
- `xmp:Rating` 解析路径与其他字段不一致(手工 find+take_while vs extract_tag_value),应统一

### 3.4 scanner.rs(763 行)+ thumbnail.rs

**scanner.rs**:7+ 职责;`scan_folders`(275-564,约 290 行)含 6+ 职责。viewer/pairing 分支(341-395 vs 396-504)是 XMP→EXIF→tone→edited 流水线的 copy-paste。`read_exif_metadata`(78-193,116 行)放错了模块。

**DRY 跨文件重复**:
- EXIF reader 初始化(File::open→BufReader→exif::Reader→read_from_container)3 份:scanner.rs:79-82, thumbnail.rs:30-36, thumbnail.rs:166-169
- mtime→Unix secs 3 份:scanner.rs:34-38, scanner.rs:244-248, thumbnail.rs:66-73

**thumbnail.rs**:8 职责混居(缓存目录 + EXIF orientation + 旋转 + 指纹 + 缓存路径 + index + 校验 + SIMD resize)。建议拆 `metadata.rs`(共享 EXIF)+ `thumbnail_cache.rs` + `image_transform.rs`。

### 3.5 db.rs + models.rs + luminar.rs + lib.rs

**db.rs**:
- `save_session`(206-209)内联时间戳计算,而同文件 `now_secs`(263-268)已存在——DRY 违背
- `settings_pairs`(11-26)/`apply_setting`(31-48)的 key 字符串与 `models.rs:AppSettings`(93-111)耦合,3 处同步风险
- `Database::new`(58-104)混 path+connection+schema+concurrency,建议抽 `init_schema()`

**luminar.rs**:
- HKLM(8-33)/HKCU(35-59)注册表查询块近乎逐行拷贝,建议抽 `query_registry_path(hive)`
- `edit_in_luminar`(72-175,103 行)混 5 职责,建议抽 `prepare_tiff()`
- **与 lumen.rs 不应合并**:不同产品(Skylum vs lumen-cli)、不同协议(Photoshop plugin vs JSON-RPC MCP)、不同传输(同步往返 vs 常驻 sidecar),重叠度 LOW

---

## 4. 前端组件层

### 4.1 App.tsx(1753 行)—— 确认 god component

**量化**:37 useState、9 useEffect、~46 useCallback、275 行 JSX。12+ 职责域:扫描、photo state、评级/flag+XMP、批量写、compare/pin、tone editing、tone save、tone state read、AI masks、Lumen sidecar、Lumen rating sync、Luminar roundtrip、external app、session persist、auto-update、settings、grid search、shortcuts、tone panel UX、metadata、modals、viewport toggle、UI render。

**DRY 重复点**:

| 重复模式 | 次数 | 位置 |
|---|---|---|
| `setGroups(prev=>prev.map(...))` | 9 | 672, 703, 777, 839, 897, 1115, 1184, 1305, 1375 |
| `targetPath=raw?.path\|\|jpg?.path` | 12+ | 散布 |
| 评级/flag 写三元组(rememberRating + setGroups + api.updateRatingFlag + markSynced) | 6 | — |

**SRP 巨型函数**:`handleScan`(78 行)、`runBatch`(81 行)是业务流函数;auto-update effect(219-272,53 行)内联在 settings effect 里;7 个 tone state + 8 个回调内联。

**建议 hook 层**:`useFolderScan`、`usePhotoCollection`、`useRatingFlagSync`、`useBatchSelection`、`useToneEditing`、`useLumenOrchestration`、`useAutoUpdate`、`useGridSearch`、`useSettings`——AppShell 从 1753 行降到 ~200 行。

### 4.2 三视口(SplitCompare/BeforeAfter/Preview)—— 最高 DRY 风险区

**重复程度**:约 60% 的非样式代码是三份近似拷贝。已有的共享层(`zoomAtPoint`、`useLumenPreview`、`getToneFilterString`、`ViewportEmptyStateView`)抽得干净,但之上的"视口交互层"是三份手抄。

**坐标系分歧(埋 bug 风险)**:Preview 用绝对坐标系(`dragStart = client - pos`),Split/BeforeAfter 用增量坐标系(`dragStart = client; dx = client - dragStart`)。三种行为本应一致,抽取共享 hook 前必须先统一。

**可消除重复约 445 行**:

| 重复块 | 单份行数 | ×份数 | 可省 |
|---|---|---|---|
| zoom 常量 + scaleLabel | 5 | 3 | 10 |
| clamp/paneMaxPan/clampTo | 15 | 3 | 30 |
| handleWheel | 20 | 3 | 40 |
| handlePointerDown/Move/Up | 30 | 3 | 60 |
| handleDoubleClick | 10 | 3 | 20 |
| 图像源决策 | 12 | 3 | 24 |
| lumenBroken latch + onError + reset | 10 | 3 | 20 |
| img style + RAW 横幅 | 15 | 3 | 30 |
| 评分/标记胶囊 | 40 | 3 | 80 |
| 空状态 + RAW-only 占位 | 20 | 3 | 40 |
| zoom 控制条 UI | 30 | 3 | 60 |
| 翻页按钮 | 20 | 2 | 20 |
| 焦点描边 | 5 | 2 | 5 |
| **合计** | — | — | **~445** |

**SRP 巨型单元**:
- `SplitCompareViewport.renderPane`(246-490,244 行):图像源决策 + 空状态 + toneFilter + 布局 + 评分业务 + Pin 交互全在一个函数
- `BeforeAfterViewport` 组件主体(50-632,580 行单函数):两个窗格 JSX(Left 419-478、Right 481-559)是对称拷贝

**已出现的措辞分叉**:RAW-only 提示文案三处各写一份(Split:"启用 LUMEN RAW 引擎后即可在此实时预览";BeforeAfter:"...对照预览";Preview:"...即可实时预览")。star title 也不一致(Split:`评 ${star} 星`;Preview:`评 ${star} 星(${star})`)。

**建议**:抽 `useZoomPan({ sync, paneCount })` + `useViewportImage(group, lumenStatus, width)` 两个 hook,`RatingFlagBar` + `ViewportImage` + `ZoomControls` + `NavOverlay` 四个子组件,三视口各从 600+ 行降到 150-200 行。

### 4.3 ThumbnailGrid.tsx(873 行)—— 9 职责

**职责**:虚拟滚动、多选状态模型、键盘导航、缩略图加载与去重缓存、搜索 UI、列数切换 UI、焦点管理、滚动定位、徽标图例 + 幽灵 a11y 节点。主组件 FC 体(80-494,约 414 行)是上帝组件。

**DRY 重复点**:
- 选择逻辑两处实现:`handleCellClick`(142-176)与 `handleListKeyDown`(211-258)各自 `new Set` + 调 `onSelectionChange` + 调 `onSelect` + 设 anchorIndex
- 列数切换按钮(313-326 vs 327-340)结构完全同构,仅字面量不同
- 徽标字母/颜色映射双重定义:图例(375-388)与单元格底栏(833-868)
- flag→颜色映射双重定义:border(682-687)与 badge(782-798)
- `pb-1.5` Tailwind 类与 `GRID_ROW_GAP_BOTTOM=6` 常量隐式耦合(注释自承"改动任一都必须同步改")

**逻辑边界问题**:
- Ctrl/Cmd 点击无法将选区清空到零(161-168:`if (next.size === 0) next.add(clicked.id)`),与 toggle 语义不符
- 键盘导航无条件收拢多选为单张(254-257),Ctrl+点击选 20 张后按方向键丢 19 张

**建议**:抽 `useMultiSelect`/`useGridKeyboard`/`useThumbnailSrc` hooks + `GridColumnSwitcher`/`GridSearchBar`/`GridBadgeLegend` 子组件 + `badges/` 角标子组件族,主组件降到 <=150 行。

### 4.4 Modals + TonalAdjuster

**纠正前提**:三个真正弹窗(SettingsModal/BatchExportModal/MetadataEditorModal)**已全部复用** `Modal.tsx`,不存在重复的遮罩/焦点陷阱/ESC 逻辑。`TonalAdjuster` 是侧边面板(`role="region"`,无遮罩无 ESC),不是弹窗。任务描述"四个 Modal 重复弹窗逻辑"不成立。Grep `role="dialog"|aria-modal` 全仓仅命中 `Modal.tsx` 一处,5/5 弹窗全部走共享外壳。

**SettingsModal(515 行)**:混合 3 个设置领域(Photoshop 路径 + Lumen 引擎配置 5 个子开关/探测/同步 + 缩略图尺寸)+ 8 个 useState。Lumen 相关 JSX 占 286-460 约 175 行。建议拆 `<LumenSettingsSection>`/`<EditorPathSection>`/`<ThumbnailSection>`。

**BatchExportModal.handleExport(119-208,90 行)**:校验 + IO 调用 + 结果文案组装(164-187,24 行字符串拼接)+ 取消分支。取消逻辑出现两次(156 的 `outcome.cancelled` 和 197 的 `isCancelRequested()`)。建议 `formatExportResult(outcome)` 独立成纯函数。

**跨组件 DRY**:
- 主操作按钮 className 在 SettingsModal:223 与 BatchExportModal:259 **完全相同**(逐字)
- `isSaving + try/finally + onError` 异步模式在 4 个组件重复 7 次:SettingsModal 3 处、TonalAdjuster 2 处、BatchExportModal 1 处、MetadataEditorModal 1 处。建议抽 `useAsyncAction(fn)` 返回 `{ run, isLoading, error, clearError }`——前端最强 DRY 抽取点之一
- 琥珀色警告框样式跨文件逐字重复(SettingsModal:435 与 TonalAdjuster:299),建议抽 `<Callout variant>`
- MetadataEditorModal 输入框样式与另两个弹窗不一致(两套设计系统并存),且缺少 SettingsModal 有的脏检测守卫——UX 不对称

**MetadataEditorModal(363 行)**:相对聚焦,职责合理,是这组里最健康的。

### 4.5 TopBar / BottomBar / Toast / Modal(叶子组件层)

**Modal.tsx 复用达标**:5 个弹窗(ConfirmDialog/ShortcutHelpModal/BatchExportModal/MetadataEditorModal/SettingsModal)全部走共享外壳,`disableClose`/`initialFocusRef`/footer/body 槽位都被合理利用。`ConfirmDialog` 的 `busy` 态通过 `onClose={busy ? () => {} : onClose}` + `disableClose={busy}` 优雅透传"任务进行中不可关"语义,不在内部重造 Esc 拦截——SRP 正向样本。Modal.tsx 是本批范本,不应改动。

#### C1. Toast.tsx —— 队列/定时器/UI/Context 四合一(SRP)

**位置**:`src/components/Toast.tsx:101-283`(`ToastProvider` 主体)

`ToastProvider` 同时承担 5 件事:
1. 队列状态管理:`push`(154-204,含去重窗口 `DEDUPE_WINDOW_MS`、`NOTICE_CAP`/`ERROR_CAP` 分区间截断)约 50 行
2. 自动消失定时器:`schedule`(129-144)、`clearTimer`(120-126)、`timers` ref、卸载清理 effect(215-221)约 32 行
3. 真值副本同步:`toastsRef` + `commit`(112-118)——为绕开 React setState 闭包做的影子 state
4. UI 渲染:`VARIANT_STYLES`(56-78)、`renderToast`(226-255)、两个 live region 的 JSX(257-282)约 78 行
5. Context 提供:`ToastContext` + `api` memo + `useToast`

**量化**:队列+定时器逻辑(105-221)约 117 行,占全文 285 行的 **41%**,是 UI 行数的 1.5 倍。一个叫 "Toast" 的组件,队列管理比渲染还重。

**关键症状**:`toastsRef` 影子 state(107-112 注释自承为什么需要它)本身就是职责未分离的证据。如果队列逻辑抽成 `useToastQueue()` hook 返回 `[toasts, push, dismiss]`,影子 state 的理由自然消失(hook 内部用 ref 是 hook 的私事,不污染组件)。

**建议拆三层**:
- `useToastQueue()` —— 持有 toasts + push/dismiss + 去重/截断规则,纯逻辑可单测
- `<ToastViewport toasts onDismiss />` —— 纯展示,两个 live region + renderToast
- `ToastProvider` 变成 10 行胶水

#### C2. TopBar —— 355 行 / 25 props / 11 职责的上帝工具栏(SRP)

**位置**:`src/components/TopBar.tsx` 整体

11 个职责:应用标识、JPG 文件夹输入、RAW 文件夹输入、扫描按钮、设置入口、筛选 select、排序 select、视图模式分段控件、调色面板开关、Luminar 入口、批量导出入口。Props 接口(17-50)有 25 个,其中 12 个 `on*` 回调。

**附带 CLAUDE.md 违规**:`TopBar.tsx:103-104` 注释自承 `showTonalPanel` vs `tonalPanelVisible` 是"缺省退回用户意图(向后兼容)"的双轨。这直接违反全局指令"不要保留向后兼容,移除过时路径"。应删除 `showTonalPanel`,只保留 `tonalPanelVisible` 派生真值。

**附带 DRY**:JPG/RAW 文件夹输入(TopBar.tsx:130-154 与 157-181)是两块 25 行近乎逐字符一致的 JSX,仅 label/handler/placeholder 不同。抽 `<FolderInput>` 即可。

**附带 SRP**:`viewModes` 配置数组(77-101)定义在函数体内,每次渲染重建,应提到模块顶层。

#### C3. 跨文件"幽灵按钮"样式在 6 个文件间复制(DRY,前端最大单一收益)

**位置**:`bg-white/5 hover:bg-white/10 active:scale-[0.96] ... rounded-md font-medium transition-colors` 出现在:
- TopBar.tsx:325, 344
- BottomBar.tsx:144, 155
- ConfirmDialog.tsx:62
- TaskProgressBar.tsx:127, 141
- SettingsModal.tsx
- BatchExportModal.tsx

Grep 该模式命中 6 个文件。各处 `px-*`/`py-*`/`gap-*`/`disabled:*` 略有出入但视觉意图一致,按钮态机(hover/active/disabled)和无障碍属性各写各的。

这是全前端最大的单一 DRY 收益点,应在三视口抽取之前做,因为 Button 是更基础的原子。建议抽 `<Button variant="ghost|primary|danger" size="sm|md" />`,把 `focus-ring` + 态机 + `active:scale-[0.96]` 收口。`ConfirmDialog` 的 destructive 主按钮(72-76)和 `ShortcutHelpModal` 的"知道了"(79)也应走同一套。

#### C4. BottomBar KeyCap vs ShortcutHelpModal `<kbd>`(DRY,次要)

**位置**:BottomBar.tsx:194-198(`KeyCap` 组件)vs ShortcutHelpModal.tsx:98, 119(`<kbd>`)

两处都是深色圆角小键帽,差异仅是多了一圈 `border border-white/15` 和 `text-white/80` vs `text-white/90`。视觉意图一致,已出现细微分歧。建议抽共享 `<KeyCap>`。

#### 次要发现

- **ConfirmDialog `closeOnConfirm` + `busy` 隐式契约**(ConfirmDialog.tsx:67-70):调用方可能传 `busy=true` 却忘 `closeOnConfirm={false}`,此时按钮显示"处理中"但弹窗已关。建议组件内 `effectiveCloseOnConfirm = closeOnConfirm && !busy`
- **Toast 双 live region 分区规则两处实现**(push 的 180-181 拆分 vs 渲染的 223-224 filter):同一个"通知 vs 错误"分区在队列和渲染各写一遍
- **TopBar `pb-[1px]` 微调在 5 个按钮里重复**(201, 292, 316, 333, 349)+ BottomBar(149, 160, 170):8 处魔法偏移
- **BottomBar `Separator`** 是一个 `|` 字符的 span,被做成组件调用 7 次(过度抽象,反向)——保留现状即可

---

## 5. hooks / services / utils / types 层

### 5.1 hooks

**useKeyboardShortcuts.ts(387 行)**:5 领域 20 键。**不应物理拆分**——guard 链顺序敏感,经 H-01/F-05/M-09/L-11 回归测试保护。但应把 switch(183-327)重构成函数表(`dispatchRating`/`dispatchNavigation`/`dispatchView`)。19-callback props 接口、19-item deps 数组(366-386)是认知负担。

**DRY 跨文件**:
- `isDialogOpen` 谓词复制:useKeyboardShortcuts.ts:71-72 与 App.tsx:1348,建议抽 `utils/domDialog.ts`
- `useTaskProgress.ts:129-145` 与 `useSessionDebounce.ts:171-199` 都实现 async listener unmount race pattern,建议抽 `useAsyncListener.ts`

### 5.2 services

**纠正前提**:任务描述假设"三个 service 应合并"。实际 `taskApi.ts` 和 `lumenApi.ts` 的文件头注释都记录了不合并的明确架构判断(taskApi 刻意保持薄只做取消+进度订阅;probeLumen 读未保存路径语义不同于已保存设置的 getLumenStatus)。**不应简单合并**,但 `api.ts` 必须按领域拆分。

**api.ts(302 行)是上帝对象**:27 个方法覆盖 7+ 领域,LUMEN 占 9/27=33% 且与 lumenApi.ts 的 2 个 LUMEN 函数跨文件分散。建议按领域拆 `services/{lumen,tone,folders,settings,export}.ts`,让 lumenApi.ts 并入新 `lumen.ts`。

**`updateToneAdjustments`(api.ts:90-98,旧 XMP 直写)与 `applyTone`(api.ts:273-275,XMP+LUMEN 统一写入)语义重叠**:若前者已无调用方,是废弃路径,违反 CLAUDE.md"移除废弃路径"要求。需 Grep 确认后删除。

**DRY**:
- dialog 文件选择器:api.ts:198-206(`selectFolderDialog`)与 lumenApi.ts:46-53(`pickLumenCliPath`)都是 `open()` + `typeof selected === 'string' ? selected : null`,建议抽 `pickFile()`
- `convertFileSrc` 同文件内 2 处(api.ts:45 未复用 toAssetUrl,api.ts:212)

### 5.3 utils

**纠正前提**:任务描述假设"autoTone.ts 含 Lumen 调用 + mask 处理"。实际 autoTone.ts 只有像素采样/直方图算法 + CSS filter 字符串生成两块,Lumen/mask 调用都在 api.ts。

**autoTone.ts(192 行)**:`computeAutoTone`(16-144,128 行,数值算法)与 `getToneFilterString`(149-192,43 行,渲染表达)共享的只有 `ToneAdjustments` 类型 + `DEFAULT_TONE` 常量。`DEFAULT_TONE` 被 toneToRecipe.ts 跨文件导入却住在"auto"文件里,名不副实。建议拆 `utils/toneMath.ts` + `utils/toneCss.ts`。

**DRY**:clamp 模式重复且语义不一致——`toneToRecipe.ts:70` 的 clamp 带 `Number.isFinite` 守卫返回 0,`autoTone.ts:70/123/128` 的内联 `Math.max/Math.min` 不带守卫。建议新建 `utils/numbers.ts` 统一。

compareGroups.ts、filterMatch.ts、zoom.ts 职责单一健康。

### 5.4 types

**types/index.ts(239 行)**:28 个类型定义跨 7 领域,Lumen 占 32%。建议拆 `types/{photos,tone,lumen,task,ui}.ts`。

---

## 6. 跨层 DRY 模式汇总

| 模式 | 涉及位置 | 建议 |
|---|---|---|
| 异步 loading+error+finally 控制流 | App.tsx、4 个 modal、hooks | `useAsyncAction(fn)` hook |
| `spawn_blocking.map_err("...任务异常: {}", e)` | commands.rs 20 处 | `join_err(e, ctx)` 或 macro |
| Lumen 准入守卫 | commands.rs 11 处 | `lumen_runtime(state) -> LumenReady` 枚举 |
| EXIF reader 初始化 | scanner.rs + thumbnail.rs 3 处 | `metadata.rs` 共享 |
| read-modify-write 骨架 | xmp.rs 3 处 | `modify_xmp(path, closure)` |
| clamp 数值工具 | autoTone.ts + toneToRecipe.ts | `utils/numbers.ts` |
| dialog 文件选择 | api.ts + lumenApi.ts | `pickFile()` |
| 命名空间 URI 三重定义 | xmp.rs 常量+字面量+match | `struct NsDef` 数组 |
| 幽灵按钮样式 | 6 文件 | `<Button variant size>` 共享组件 |
| KeyCap / kbd | BottomBar + ShortcutHelpModal | 共享 `<KeyCap>` |

---

## 7. 重构路线图(优先级排序)

**P0 — 正确性止血(先做,独立于重构)**:
1. xmp.rs reject 分支:删除 `write_xmp_rating_minus_one`,reject 直接复用已读 meta(2.1)
2. lumen.rs `tool_to_command_id` 未知工具改 Err/panic(2.2)
3. lumen.rs `ProcessTransport::read_line` 区分 Disconnected 与 Timeout(2.3)
4. xmp.rs `append_our_block` 畸形文件改 Err(2.4)

**P1 — 高收益 DRY 抽取(低风险,可独立进行)**:
5. **抽 `<Button variant size>` 共享组件** —— 消除 6 文件幽灵按钮重复(C3),前端最大单一 DRY 收益点,基础原子优先
6. `useAsyncAction(fn)` hook —— 消除 7 处异步样板(4.4)
7. 三视口 `useZoomPan` + `useViewportImage` + `RatingFlagBar` + `ViewportImage` —— 消除 ~445 行(4.2)
8. **Toast 拆三层** —— `useToastQueue` + `<ToastViewport>` + 薄 Provider(C1)
9. commands.rs Lumen 守卫 helper + 降级策略统一(3.2)
10. xmp.rs `modify_xmp` + `extract_f32` + 命名空间结构体(3.3)

**P2 — SRP 巨石拆分(高收益但高风险,需测试覆盖)**:
11. lumen.rs 拆 14 子模块(3.1)—— 最大单文件,需配合测试随实现迁移
12. App.tsx 抽 hook 层(4.1)—— 需保持 H-01/F-05/M-09/L-11 等回归测试通过
13. commands.rs 按领域拆 8 子模块(3.2)
14. ThumbnailGrid 拆 hooks + 子组件(4.3)
15. **TopBar 拆 `<SourceRow>` + `<ToolbarRow>`**,删 `showTonalPanel` 兼容层(C2)
16. SettingsModal 拆 3 个 section(4.4)

**P3 — 清理(随手做)**:
17. 确认 `updateToneAdjustments` 调用方,无则删除(5.2)
18. 删除 xmp.rs `write_xmp_full` 透传层、`read_xmp` dead_code(3.3)
19. 确认 lumen.rs `Supervisor` 是否死代码(3.1)
20. `utils/numbers.ts` 统一 clamp(5.3)
21. lumen.rs 测试换 `tempfile::TempDir`(3.1)
22. types 按领域拆分(5.4)
23. `<KeyCap>` 抽取(C4)、ConfirmDialog 隐式契约消除
24. useKeyboardShortcuts switch 重构为函数表(5.1)
25. `utils/domDialog.ts` + `useAsyncListener.ts` 抽取(5.1)

---

## 8. 量化指标

**后端最大文件**:lumen.rs 3213 行(50% 测试)、commands.rs 1693 行(17% 测试)、xmp.rs 1168 行(57% 测试)、scanner.rs 763 行

**前端最大文件**:App.tsx 1753 行、ThumbnailGrid.tsx 873 行、SplitCompareViewport ~650 行、BeforeAfterViewport ~630 行、SettingsModal 515 行、TopBar 355 行、Toast 285 行

**后端巨型函数 Top**:export_items(123 行)、lumen_preview_cmd(108 行)、build_our_description(101 行)、lumen_sync_ratings_cmd(84 行)、apply_tone_cmd(84 行)、scan_folders(~290 行)、read_exif_metadata(116 行)

**前端巨型函数 Top**:SplitCompareViewport.renderPane(244 行)、BeforeAfterViewport 组件主体(580 行单函数)、ThumbnailGrid FC 体(414 行)、BatchExportModal.handleExport(90 行)、computeAutoTone(128 行)

**最大重复消除潜力**:三视口 ~445 行 + commands.rs 守卫/错误转换 ~50 行 + lumen.rs spawn/handshake/重置 ~30 行 + modals 异步样板 ~70 行 + 幽灵按钮 6 文件 ~60 行 + xmp.rs read-modify-write/parse ~40 行 ≈ **700+ 行可消除**

---

## 9. 不应改动的部分(反向结论)

审计中确认的几个**不该动**的点,避免过度重构:

- **luminar.rs 与 lumen.rs 不应合并**:不同产品、不同协议、不同传输,重叠度 LOW
- **taskApi.ts / lumenApi.ts 不应并入 api.ts**:有文档化的架构理由保持独立
- **useKeyboardShortcuts.ts 不应物理拆分**:guard 链顺序敏感,有回归测试保护;只重构 switch 为函数表
- **Modal.tsx 不需要动**:5 个弹窗已正确复用它,职责单一,是范本
- **MetadataEditorModal 相对健康**:363 行,职责聚焦,是 modals 组里最不该先动的
- **compareGroups.ts / filterMatch.ts / zoom.ts**:职责单一,粒度健康
- **三视口已有的共享层**(`zoomAtPoint`/`useLumenPreview`/`getToneFilterString`/`ViewportEmptyStateView`):抽得干净,不要再动
- **TaskProgressBar / ShortcutHelpModal / ConfirmDialog / ViewportEmptyState**:职责单一健康,不应改动
- **BottomBar `Separator`**:虽是过度抽象,但保留现状即可,不值得动

---

## 10. 纠正任务描述中的错误前提

审计过程中发现原始任务框架里有几处事实性错误,直接影响判断方向,在此明确指出:

1. **"autoTone.ts 含 Lumen 调用 + mask 处理"** —— 不成立。autoTone.ts 只有像素采样/直方图算法 + CSS filter 字符串,Lumen/mask 调用都在 api.ts
2. **"TonalAdjuster 管色调计算 + Lumen 调用 + mask 处理"** —— 不成立。它委托 `onChange`/`onSave`/`onApplyMask`/`onApplyPreset` props,不直接做这些,只管 UI 状态
3. **"四个 Modal 重复遮罩/焦点陷阱/ESC 逻辑"** —— 不成立。三个真弹窗已全部复用 Modal.tsx;TonalAdjuster 是侧边面板非弹窗,分类错误。Grep 全仓 `role="dialog"|aria-modal` 仅命中 Modal.tsx 一处
4. **"三个 service 应合并"** —— 过度简化。taskApi/lumenApi 有文档化理由保持独立,真正该拆的是 api.ts 这个上帝对象
5. **lumen.rs 文件头注释宣称"不包含常驻 MCP"** —— 与实际内容冲突,文件内含完整 McpClient/ProcessTransport/Supervisor/LumenRuntime,注释已失效

---

## 11. 新增 CLAUDE.md 违规点

除第 10 节的错误前提外,审计中还发现一处明确的 CLAUDE.md 违规:

- **TopBar `showTonalPanel`/`tonalPanelVisible` 双轨**(TopBar.tsx:103-104):注释自承为"缺省退回用户意图(向后兼容)"的兼容层。直接违反全局指令"不要保留向后兼容,移除过时路径"。应删除 `showTonalPanel`,只保留 `tonalPanelVisible` 派生真值

---

## 12. 缺口与局限

- **lumen.rs 2651-2653、2917-2919 的 raw string 路径疑似被换行打断**:agent 标注"无法 100% 排除是 Read 工具行宽渲染假象",建议直接打开源文件核对原始字节
- **`Supervisor` 是否死代码**:1-1600 行内未引用,需确认 1600 行之后(测试段)是否使用
- **`updateToneAdjustments` 是否还有调用方**:需 Grep 确认才能定性能否删除
- 本报告基于静态阅读,未运行测试验证各缺陷的实际触发路径;P0 的 4 条正确性缺陷建议在修复时先写复现测试

---

## 13. 最终组件健康度地图(全前端)

| 组件 | 行数 | 职责数 | SRP | 处置 |
|---|---|---|---|---|
| App.tsx | 1753 | 12+ | 严重违反 | P2 抽 hook 层 |
| ThumbnailGrid.tsx | 873 | 9 | 严重违反 | P2 拆 hooks+子组件 |
| BeforeAfterViewport | ~630 | 1(但单函数 580 行) | 结构违反 | P1 抽共享层 |
| SplitCompareViewport | ~650 | 1(但 renderPane 244 行) | 结构违反 | P1 抽共享层 |
| SettingsModal | 515 | 3 领域 | 违反 | P2 拆 section |
| TopBar | 355 | 11 | 违反 | P2 拆 Row |
| PreviewViewport | ~450 | 1 | 结构违反 | P1 抽共享层 |
| BatchExportModal | ~360 | 1(handleExport 90 行) | 边界 | P2 抽 formatResult |
| MetadataEditorModal | 363 | 1 | 健康 | 不动 |
| Toast | 285 | 4 | 违反 | P1 拆三层 |
| Modal.tsx | — | 1 | 健康(范本) | 不动 |
| TaskProgressBar | — | 1 | 健康 | 不动 |
| ShortcutHelpModal | — | 1 | 健康 | 不动 |
| ConfirmDialog | — | 1 | 健康(轻微契约) | 不动 |
| ViewportEmptyState | — | 1 | 健康 | 不动 |
| BottomBar | — | 3 子职责 | 边界可接受 | 不动 |

---

## 结论

14 份报告全部到齐,统一审计完成。

最终判断:这不是一个"风格脏但能跑"的代码库——它有几个真实的正确性/数据丢失缺陷(xmp.rs reject 最严重),以及两个明确的巨石(lumen.rs 3213 行、App.tsx 1753 行)需要按职责拆分。

重构应从 **P0 正确性止血**开始,而非从 DRY 抽取开始。DRY 抽取从 `<Button>` 原子和三视口共享层这两处最高收益点切入。SRP 巨石拆分集中在 lumen.rs(后端)和 App.tsx(前端)两个最大单元。新增的 Toast 拆层和 TopBar 拆 Row 是规模可控的独立改进项,可夹在 P1/P2 之间进行。
