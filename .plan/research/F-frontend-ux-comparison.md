# F — 前端 / UX 集成面比对报告

- **日期**: 2026-10-11
- **客体钉死**: lumen-raw `43b4ebe2a84284098523219d597873a52197a1b7`（v1.6.0）
- **宿主**: gallery-flask（Tauri 2.0 + Rust + React 19 + TS），宿主仓库**只读**
- **集成决策前提**: lumen 渲染能力进宿主只做**显示与薄调节**（P0 真实 RAW 预览显示；P1 recipe 显示/回传 + 评级同步；P2 AI 增强一键触发）。宿主保持"快速选片"心智：键盘 1-5/P/X 评级，C 对比，[ ] 基准，O 外部打开。前端最小侵入（920 行 AppShell 少动，新状态用独立 hook 隔离）
- **配套文档**: `.plan/lumen_raw_integration_plan.md`、`.plan/research/` B/D/E 系列
- **方法**: 逐文件比对，每点带宿主实测行号；客体侧只依据 `README.zh-CN.md` 的功能描述对齐用户心智

---

## 0. 结论速查

| # | 课题 | 结论 |
|---|---|---|
| 1 | 宿主状态流 | AppShell 共 **24 个 state/ref**（:34-72）；`handleRate` :430-449 / `handleFlag` :451-471 是"乐观更新 + 后台 sync + 失败非阻断"三段式，**lumen 评级同步就挂这里，不动结构** |
| 2 | api.ts | **14 个 invoke 包装**（:9-176）+ 2 个非 invoke 辅助（`selectFolderDialog` :181-189、`toAssetUrl` :194-196）；新命令按 `*_cmd` 命名铁律追加（:5-197 单对象） |
| 3 | 三预览组件 RAW 流 | 三者都用 `api.toAssetUrl(jpg \|\| raw)`（PreviewViewport :132-136 / BeforeAfter :106-110 / Split :160-164）；**RAW_ONLY 时是把 RAW 原始字节喂 `<img>`**，浏览器解码不了 → 收益最大接入点 = `PreviewViewport.tsx:132-136` |
| 4 | TonalAdjuster ↔ crs:* | 6 滑杆（:34-105）↔ `ToneAdjustments`（types :26-33）↔ Rust `xmp.rs:89-94` 读 / `:167-182` 写，字段**一一对应**；P1 改走 `edit.apply` 只改 `onSaveXmp` 的落点，滑杆本体不动 |
| 5 | UX 接入点 | SettingsModal 仿 photoshopPath 块（:92-124）加"RAW 增强引擎"开关 + sidecar 路径；深链按钮仿 Luminar 三处入口（TopBar :306-323 / PreviewViewport :378-393 / BeforeAfter :199-212）；edited 角标复用见 §5.3 |
| 6 | 降级 UX 契约 | 徽标三态（绿/黄/灰）+ Toast 四级文案 + 预览 onError 静默回退；**全部非阻断**，对齐 `handleOpenExternal` :481-490 的 try→fallback 先例 |
| 7 | 快捷键结构 | `useKeyboardShortcuts` props 全 optional（:3-21）+ switch（:94-234）；**E 已被调色面板占用**（:224-230）→ AI 增强须换键，候选 `Shift+E`；G 空闲可用 |
| 8 | types 约定 | camelCase 铁律两侧对齐（Rust `#[serde(rename_all="camelCase")]` models.rs :4）；新类型 5 个 + AppSettings 3 字段 + PhotoGroupInfo 1 字段 |

---

## 1. 宿主状态流盘点（App.tsx AppShell）

### 1.1 AppShell 全部 state / ref（24 项）

| 行号 | 名称 | 类型 | 与 lumen 接入的关系 |
|---|---|---|---|
| :34 | `jpgFolder` | string | 无（评级同步的 folder 参数来源） |
| :35 | `rawFolder` | string | 无 |
| :36 | `groups` | `PhotoGroupInfo[]` | **P1 角标/recipe 载体**：新字段挂在 group 上，不动 state 本身 |
| :37 | `selectedIndex` / :38 `compareIndex` | number | 无（窄索引联动 :165-169, :173-179） |
| :39 | `pinnedId` / :40 `isPinnedOnLeft` | string \| null / boolean | 无（[ ] 基准铁律不变） |
| :41 | `isLoading` | boolean | 无 |
| :42 | `viewMode` | `'single'\|'split'\|'before_after'` | P2 深链成功后复刻 `setViewMode('before_after')`（:620 先例） |
| :43-48 | `filterMode` / `sortOrder` / 4 个 modal open | 枚举/boolean | 无（SettingsModal 复用 :46） |
| :49 | `settings` | `AppSettings \| null` | **lumen 开关/路径读这里**（类型扩展见 §8） |
| :53-55 | `gridSearchOpen` / `gridSearch` / `gridSearchFocusToken` | — | 无（:51-52 注释已声明"owned here"模式，**新状态照样隔离**） |
| :58 | `toneMap` | `Record<string, ToneAdjustments>` | **P1 核心**：recipe 显示就叠在这层 |
| :59-61 | `showTonalPanel` / `isLuminarRunning` / `isHoldOriginal` | boolean | P2 模板：`isLumenBusy` 照抄 :60 模式 |
| :64-68 | `pendingUpdate` | object \| null | 无 |
| :72-75 | `previewImageRef` + `setPreviewImage` | ref + cb | **P0 注意**：lumen 渲染的 `<img>` 仍需回传元素，否则 auto-tone（:556）失效 |

> **最小侵入推论**：24 项里只有 `groups` / `settings` / `toneMap` / `viewMode` / `isLuminarRunning` 五类被 lumen 触碰，且全通过既有 handlers。**新增状态（lumen 握手状态、预览 URL 缓存）一律进独立 hook**，AppShell state 数量保持 24。

### 1.2 乐观更新三段式（P1 评级同步的挂载点）

```
handleRate :430-449
  ① setGroups 本地立即改 (:437-439)          ← 乐观，UI 零延迟
  ② await api.updateRatingFlag (:443)        ← XMP 侧边栏（真实落盘）
  ③ catch → reportRatingFlagError (:445)     ← 非阻断 toast（:419-427）
```

- **共同特征**：先本地、后同步、失败只提示不回滚。文案口径（:422-424）："界面上的星级和保留/淘汰仍然有效，但不会同步到 Lightroom。"
- **lumen 接入方案（不改结构）**：在 ② 之后串一次 `api.lumenSyncRating(targetPath, rating, flag)`（Option B 单发，低频），catch 走**独立的** `reportLumenSyncError`，不得与 XMP 错误混报——两者修复动作不同（一个查文件权限，一个查 lumen 安装）。
- `handleFlag` :451-471 与上完全同构（:460-462 / :465 / :467）。

### 1.3 `handleOpenLuminar` :596-632 —— 深链/P2 的完整先例

| 步骤 | 行号 | 行为 | P2 复用方式 |
|---|---|---|---|
| 1 | :601 | `setIsLuminarRunning(true)` | 照抄 `setIsLumenBusy(true)` |
| 2 | :603 | `await api.openInLuminarRoundtrip(targetPath)` 返回 editedPath | 换成 `api.lumenDeeplink(targetPath)` |
| 3 | :605-611 | 手工拼 `PhotoFileInfo`（size 0 / mtime now） | **坑**：DNG 副本落盘后应重新 stat，不拼假值 |
| 4 | :613-617 | `setGroups` 写入 `edited` | 照抄（P2 AI 产物） |
| 5 | :620 | `setViewMode('before_after')` 自动切前后对照 | 照抄：P1 recipe 渲染成功也应切 Y 视图 |
| 6 | :621-623 | success toast | 改文案（§5.2） |
| 7 | :624-628 | error toast 带**修复指引**（"请确认已安装…已在设置中允许…"） | 照抄句式：问题 + 原因 + 下一步 |
| 8 | :629-631 | `finally` 复位 busy | 照抄 |

### 1.4 ToastProvider :914-920 与启动期状态加载

`ToastProvider` 包裹 `AppShell`（:915-919），`useToast()` 在 :32 取用。启动时 `api.getSettings()`（:79-94）**失败也有 toast**（:91-93）→ "状态类信息用 toast 告知"是既定范式，lumen 握手结果可用同款，但须在启动 1500ms 定时器之后做（仿 :115，避免阻塞首屏）。Toast 时长 error 7000ms / 其余 4000ms，栈上限 3 条（Toast.tsx :32-36, :89）→ **降级文案必须短**。

---

## 2. api.ts 方法签名清单（14 个 invoke 包装）

单对象 + `invoke` 唯一出口（:1 import，:5 `export const api = {`）。**新命令一律加在这里，禁止组件内直接 invoke。**

| # | 方法（行号） | 签名 | 后端命令 | lumen 接入 |
|---|---|---|---|---|
| 1 | `scanFolders` :9-19 | `(jpgFolder: string, rawFolder?: string, sortOrder?: string) => Promise<FolderScanResult>` | `scan_folders_cmd` | P1 扫描时顺带探测同名 `.lumen`（Rust 侧） |
| 2 | `getThumbnail` :24-30 | `(filePath: string, width?: number) => Promise<string>` | `get_thumbnail_cmd` | 宫格仍走它（内嵌 JPEG），P0 不改 |
| 3 | `updateRatingFlag` :35-47 | `(filePath, rating: number, flag: string, syncXmp = true) => Promise<boolean>` | `update_rating_flag_cmd` | **并行加 lumen 评级同步**（§1.2） |
| 4 | `openInPhotoshop` :52-60 | `(filePath, customPsPath?: string) => Promise<boolean>` | `open_in_photoshop_cmd` | 无 |
| 5 | `openInDefaultApp` :64-69 | `(filePath: string) => Promise<boolean>` | `open_in_default_app_cmd` | 无（降级链末端，:484 先例） |
| 6 | `updateToneAdjustments` :74-82 | `(filePath, tone: ToneAdjustments) => Promise<boolean>` | `update_tone_adjustments_cmd` | **P1 分支点**：写 crs:* 或 `edit.apply`（§4） |
| 7 | `openInLuminarRoundtrip` :87-91 | `(filePath: string) => Promise<string>` | `open_in_luminar_roundtrip_cmd` | 深链按钮的语义邻居（P2 :128 模式） |
| 8 | `trashPhotos` :96-100 | `(filePaths: string[]) => Promise<number>` | `trash_photos_cmd` | 无 |
| 9 | `batchExport` :105-117 | `(items, targetFolder, includeRaw, includeJpg) => Promise<number>` | `batch_export_cmd` | P2 批量"套用调色"模板 |
| 10 | `batchUpdateMetadata` :122-134 | `(filePaths, lensModel?, focalLength?, aperture?) => Promise<number>` | `batch_update_metadata_cmd` | P1 评级批量同步模板（同"数组入参"签名） |
| 11 | `getSettings` :139-141 | `() => Promise<AppSettings>` | `get_settings_cmd` | AppSettings 加 lumen 字段后**签名不变** |
| 12 | `saveSettings` :146-148 | `(settings: AppSettings) => Promise<boolean>` | `save_settings_cmd` | 同上（:146 整体对象，扩展零成本） |
| 13 | `saveSession` :153-165 | `(jpgFolder, rawFolder, lastIndex, sortOrder) => Promise<boolean>` | `save_session_cmd` | 无 |
| 14 | `loadSession` :170-176 | `(jpgFolder) => Promise<[number, string] \| null>` | `load_session_cmd` | 无 |

**非 invoke 辅助（2 个）**：`selectFolderDialog` :181-189（dialog 插件）、`toAssetUrl` :194-196（`convertFileSrc`，P0 lumen 预览 URL 也经它转 asset://）。**计划新增**：`lumenStatus`/`lumenRenderPreview`（P0）、`lumenGetRecipe`/`lumenApplyRecipe`/`lumenSyncRatings`（P1）、`lumenEnhance`/`lumenDeeplink`（P2）——签名一律照 §2 表，`api.lumen*` 在 Rust 侧不可用时返回 `null`/由前端兜（§6），**不得让 invoke reject 冒泡到未捕获区**。

---

## 3. 三个预览组件的 RAW 数据流差异与接入点

### 3.1 数据流对照

| 组件 | 当前 RAW 取源（行号） | 实际行为 | tone 作用 | lens 接入改动点 | 优先级 |
|---|---|---|---|---|---|
| `PreviewViewport`（单图） | :132-136 `api.toAssetUrl(group.jpg?.path \|\| group.raw?.path)` | RAW_ONLY 时 **RAW 字节直接进 `<img>`** → 浏览器无法解码，显示破图/空白 | CSS filter :187 `getToneFilterString` | **:132-136 改为 `useLumenPreview(group)`**；:187 保留作降级样式 | **P0 最高** |
| `BeforeAfterViewport` | before :106-110 同上；after :114-116 `edited?.path \|\| beforeSrc` | Luminar 产物走 edited；否则"原片 vs 原片+CSS filter"（:119） | :118-119 有 edited 时 `'none'` | **after 源 :114-116 改 lumenRenderPreview(recipe)**；头部文案 :156-158 加分支 | **P1** |
| `SplitCompareViewport` | renderPane :160-164 同 toAssetUrl | 双图各自取源，**无 tone / 无 edited 概念**（img :191-201 无 filter） | 无 | P0/P1 **不动**（双图对比心智=选基准，非调色） | P2 可选 |
| `ThumbnailGrid` | GridPhotoCell :374-387 `api.getThumbnail(path, 200)` | 内嵌 JPEG 缩略图（快、够用） | 无 | P0 不动；P1 只加 L 角标（§5.3） | P0 不改 |

**关键差异**：单图/双图用 `convertFileSrc` 直读原文件（零拷贝，但 RAW 不可解码）；宫格走 Rust 抽内嵌 JPEG。**lumen 渲染是第三条流**（Rust 缓存文件 → `convertFileSrc`），与两者都不冲突。

### 3.2 接入点 1：`PreviewViewport.tsx`（P0，收益最大）

```
现状 :132-136   const imageSrc = group?.jpg?.path ? toAssetUrl(jpg) : group?.raw?.path ? toAssetUrl(raw) : null;
                if (!group || !imageSrc) → 空态 (:138-161)
目标 :132-136   const { src, loading, degraded } = useLumenPreview(group);  // null = 回退旧路径
```

- **新增 hook `src/hooks/useLumenPreview.ts`**（隔离 AppShell）：输入 group，输出 `{src, loading, degraded}`；内部 `useMemo` 按 `group.id` 缓存 URL，RAW+JPG 都存在时**仍优先 JPG**（快，选片心智），仅 RAW_ONLY 或用户开了"始终 RAW 预览"才走 lumen。
- **loading 态**：组件当前无 loading 分支 → 在 :179 `<img>` 前加 `{loading && <PreviewSkeleton/>}`（骨架或"正在解码 RAW…"文本，样式仿 :441 `加载中`）。
- **降级回退**：`<img onError>` → `setDegraded(true)` → src 回落 `toAssetUrl`。**静默，不 toast**（§6 契约 3）。
- **`onImageElement` :180 必须保留**：lumen 渲染的图也要回传元素，否则 auto-tone（App :556-559）取不到 histogram。
- **tone filter :187**：lumen 预览 + recipe 同时存在时 filter 应为 `'none'`（与 BeforeAfter :119 的 `hasLuminarEdit` 判定同构），否则双重调色。

### 3.3 接入点 2：`BeforeAfterViewport.tsx`（P1）

- :113 `hasLuminarEdit` → 扩展为 `hasLumenRender`（edited 文件 **或** recipe 渲染）。
- :114-116 `afterSrc` → recipe 存在时 `api.lumenRenderPreview(rawPath, 1600, recipeJson)`；此时 before 侧（:106-110）应改用**同一张 RAW 的 lumen 无 recipe 渲染**，保证"同源对比"（否则 before 是内嵌 JPEG、after 是 lumen 解码，色差会被误读为调色效果）。
- :118-119 `toneFilter`：`hasLumenRender` 时置 `'none'`。
- :156-158 头部说明文案加第三分支：`'右侧呈现 LUMEN RAW recipe 渲染'`。
- :200-212 Luminar 按钮旁并列深链按钮（P2，§5.2）。

### 3.4 接入点 3：`ThumbnailGrid.tsx`（P1 角标）

- :221-235 legend 加一行 `L`（琥珀色，与 X :227 / T :230 / E :233 并列）。
- :493-530 徽章区在 `group.edited`（:521-529）**之后**加 `group.lumenRecipe` 角标；`:397-409 description` 加 `group.lumenRecipe ? '含 LUMEN 调色' : null`（屏幕阅读器可见）。
- thumb 本体不动（:430-439）——宫格性能是选片流畅度命门。

---

## 4. TonalAdjuster 调色 UI ↔ Rust ToneAdjustments（crs:*）↔ lumen recipe

### 4.1 三段字段映射（实测行号）

| UI 滑杆（TonalAdjuster :34-105） | 范围/步进 | `ToneAdjustments` 字段（types :26-33） | Rust 读（xmp.rs :89-94） | Rust 写（xmp.rs :167-182） | lumen recipe 词表键（README:79 16 滑块） |
|---|---|---|---|---|---|
| 曝光 exposure :45-54 | -3…+3, 0.05 | `exposure` | `crs:Exposure2012` | `<crs:Exposure2012>{:+.2}` :167 | `exposure`（曝光） |
| 阴影 shadows :55-64 | -100…100, 1 | `shadows` | `crs:Shadows2012` :91 | `:173` | `shadows`（暗部） |
| 高光 highlights :65-74 | -100…100, 1 | `highlights` | `crs:Highlights2012` :90 | `:170` | `highlights`（亮部） |
| 色温 temperature :75-84 | -100…100, 1 | `temperature` | `crs:Temperature` :92 | `:176` | `temperature`（冷暖） |
| 色调 tint :85-94 | -100…100, 1 | `tint` | `crs:Tint` :93 | `:179` | `tint`（色调） |
| 对比度 contrast :95-104 | -100…100, 1 | `contrast` | `crs:Contrast2012` :94 | `:182` | `contrast`（对比度） |

**Rust 结构体**：`models.rs:35-44` `ToneAdjustments`（6 个 f32，`rename_all="camelCase"`）；`scanner.rs:54-70` `extract_tone_from_xmp` 在扫描期填入 `group.tone`。

### 4.2 P1 六滑杆"改走 edit.apply"的具体含义

**边界判定**：宿主持有的是 **6 字段交集**，lumen 有 16 个全局滑块（README:79）+ 八色 HSL + 曲线 + 分级 + 暗角颗粒。集成决策已钉死"薄调节"→ **只透传这 6 个，其余 10 个宿主不产生、不修改**。

| 方向 | 入口 | 改动 | 注意 |
|---|---|---|---|
| 宿主观 → lumen | TonalAdjuster "同步 XMP" 按钮 :225-240 → App `handleSaveToneToXmp` :570-593 | **按钮文案与落点二选一**：lumen 可用时 `api.lumenApplyRecipe(path, toneToRecipe(tone))`，不可用时回落 `api.updateToneAdjustments`（:578 现值） | 按钮 label（:237-239）需随状态切换："同步 XMP" / "套用到 LUMEN RAW" |
| lumen → 宿主观 | `api.lumenGetRecipe` → toneMap | recipe → `ToneAdjustments` 反投影（取 6 个交集字段） | **必须截断/夹取**到 UI 范围（exposure 尤其，见 4.3） |
| 预览（P1 主路径） | `useLumenPreview` 带 recipeJson | §3.2/§3.3 | 不改滑杆 |

**新增纯函数 `src/utils/toneToRecipe.ts`**（仿 `autoTone.ts` 无依赖风格）：`(tone: ToneAdjustments) => { adjustments: {...} }`；反向 `recipeToTone(recipeJson): ToneAdjustments`。**两函数写单测**——这是唯一需要精确对应的地方，UI 不动。

### 4.3 已知不一致（需产品决策，P1 前置）

1. **exposure 范围三处不一**：UI `min=-3 max=3`（:49-50）vs types 注释 `-5.00..+5.00`（:27）vs lumen recipe 无硬约束。**建议统一到 -5..+5**，否则 lumen 侧 +4EV 的 recipe 回传会被 UI 夹断，用户看到"套用了但没变化"。
2. **temperature 量纲**：crs:Temperature 是绝对色温（K，如 5500），UI 的是相对偏移（-100..100）。`xmp.rs:176` 直接写偏移值 → **宿主观的色温写进 XMP 后 ACR 解释为绝对 K**，这是既有语义模糊，P1 透传到 lumen 前必须确认 lumen recipe 的 `temperature` 是相对还是绝对（以 `edit.get` 实返值为准），否则双向同步会把色温放大数百倍。
3. **tint 与 hue-rotate 近似**：`getToneFilterString` :186-189 用 hue-rotate 近似 tint，与真实显影无关；lumen 接入后 tint 进 recipe 由 lumen 真算，CSS filter 仅剩降级用途。

---

## 5. UX 接入点设计

### 5.1 SettingsModal：加"RAW 增强引擎"开关 + sidecar 路径

**模板 = 现有 photoshopPath 块**（:92-124：label + input + browse 按钮 + 说明文案；browse 逻辑 :34-44 用 `open({filters:[exe/app]})`；保存 :46-58 `api.saveSettings` + `onSettingsSaved`）。

在 :124（Photoshop 块结束）与 :126（Thumbnail Width 块）之间插入：

| 控件 | 类型 | 绑定字段（§8） | 说明文案要点 |
|---|---|---|---|
| 启用 LUMEN RAW 引擎 | checkbox | `lumenEnabled` | "关闭后行为与此前完全一致，零开销" |
| LUMEN RAW CLI 路径 | text + browse（exe） | `lumenPath` | 默认值 `%LOCALAPPDATA%\Programs\LUMEN RAW\lumen-cli.exe`（README:132 现成路径）；留空则自动探测 |
| RAW 预览尺寸 | number（600-2400） | `lumenPreviewWidth` | 默认 1600，对齐 lumen `preview_limit`；越大越慢 |
| 握手状态 | **只读行 + 重新检测按钮** | — | `lumen_status_cmd` → `{available, backend, version}`；未握手时灰字"尚未检测" |
| （P1）同步评级按钮 | button | — | 手动触发 `lumenSyncRatings('export'\|'import')`；结果显示 "导入 X / 导出 Y / 冲突 Z" 冲突 Z>0 时跳列表 |

**验收锚点**：保存重启后，`getSettings` :79-86 带回新字段 → TopBar 徽标（§5.2）反映握手结果。

### 5.2 TopBar 状态徽标 + 深链按钮（P2）

**徽标位置**：TopBar Row2 的 `ml-auto` 动作区（:262）**最前端**，与 Luminar AI 按钮（:307-323）相邻同组。

```
[Sparkles 图标] LUMEN RAW  ●    ← 点击打开 SettingsModal（复用 :176 的 onOpenSettingsModal）
   ● 绿 = sidecar 就绪（backend: "sidecar"）
   ● 黄 = editor 直连（backend: "editor"，Option C 活着）
   ● 灰 = 不可用/未配置（backend: "none"）+ title 说明原因（§6 文案）
   lumenEnabled=false → 徽标整体不渲染（零开销验收）
```

- 实现：**新组件 `src/components/LumenStatusBadge.tsx`**（< 60 行），props 只吃 `status: LumenStatus | null` + `onOpen: () => void`；状态由 §7 的 hook 提供，TopBar 自身不改动（TopBar 已是 350 行，只加一个 slot prop）。
- 深链按钮（P2）：三处并列于既有 Luminar 入口旁——
  - `PreviewViewport.tsx` :394「外部打开」**之前**（quick action bar 内，与 Luminar :379-393 相邻）；
  - `TopBar.tsx` :323 Luminar 按钮之后；
  - `BeforeAfterViewport.tsx` :212 Luminar 按钮之后。
  - 行为仿 `handleOpenLuminar`（§1.3）：busy → `api.lumenDeeplink(path)` → 成功 toast「已在 LUMEN RAW 中打开」；失败 toast「请先启动 LUMEN RAW，或导出后用其它程序打开」。
- 文案里的应用名统一 **"LUMEN RAW"**（README 官方写法），与现有 "Luminar AI"（两个不同产品）严格区分，避免用户混淆。

### 5.3 edited 角标模式 → `.lumen` 产物的复用

**现有模式**（三层必须同步改，缺一即破）：
1. Rust：`scanner.rs:16-52` `find_edited_version` 只认 `*_Luminar.*` / `*_edit.*`（8 个候选，:17-26）；
2. 宫格：legend（ThumbnailGrid :229-234）+ 角标 `E`（:521-529）+ description（:405）；
3. 前后对照：`hasLuminarEdit` :113 驱动 after 源与角标文案（:290-294）。

**复用方案**：

| 产物 | 语义 | 前端改动 | Rust 改动（前端契约） |
|---|---|---|---|
| 同名 `.lumen` 工程 | "已调色" | **新增** `group.lumenRecipe?: boolean` + L 角标（§3.4） | `scanner.rs` `find_edited_version` 旁新增 `find_lumen_project` 检测 `.lumen` 存在 |
| AI 增强 DNG 副本（P2） | "精修成果" | **复用 E 角标**，title :524 改「包含精修成果 (LUMEN RAW)」；BeforeAfter :156-158 文案分支拓展 | candidates 加 `*_lumen.*`/DNG 变体（DNG 副本命名以上游 `reserve_copy` 为准，E 系列报告已定位） |

**关键决策**：`.lumen` **不复用** `edited` 字段——`edited` 在 BeforeAfter 里表示"右侧换成实文件"（:114-116），而 `.lumen` 需要的是"右侧带 recipe 渲染"，语义不同，混用会让 P1 前后对照逻辑炸掉。

---

## 6. 降级 UX 契约（lumen 不可用时各入口表现）

**设计原则**（全部从既有先例推导）：
1. **非阻断**：任何 lumen 失败不得打断选片主流程。先例 = `handleOpenExternal` :481-490（Photoshop 失败 → `openInDefaultApp` → 才 toast）。
2. **分级用 toast**：配置类问题用 `info`（用户可_action_），主动触发失败用 `error`（7000ms，Toast :35）。
3. **持久状态只靠徽标**：不用弹窗（ConfirmDialog 仅留给更新确认 :896-909）。
4. **每次失败带下一步**：句式 = 现象 + 原因 + 动作（抄 :627「请确认 Luminar AI 已安装，并已在「设置」中允许作为 Photoshop 插件运行。」）。

### 6.1 四场景契约表

| # | 场景 | 触发点 | 徽标 | Toast（文案见 6.2） | 阻断？ | 预览回退 |
|---|---|---|---|---|---|---|
| 1 | **未安装 / 路径空** | 启动握手（:115 定时器后）+ 点任何 lumen 入口 | 置灰，title = 文案 T1 | 点击时 info T1；启动时**不** toast | 否 | 内嵌 JPEG（即今日行为） |
| 2 | **握手失败 / sidecar 崩溃** | `lumen_bridge` 标记 not ready | 置灰，title = T2 | 仅当用户主动点了渲染/增强时 error T2 | 否 | 内嵌 JPEG，下次调用自动重拉 |
| 3 | **版本漂移** | 握手工具表断言失败（计划 :99 缺任一 P0/P1 工具） | 置灰 + title 显示实获版本 | 首次 info T3 | 否 | 内嵌 JPEG |
| 4 | **用户主动关闭开关** | `lumenEnabled=false` | **整块不渲染** | 无 | 否 | 内嵌 JPEG；零 invoke 调用 |

**预览渲染中崩溃**（最刁钻场景）：`<img onError>` 触发（§3.2）→ 静默回落 `toAssetUrl`，**不 toast**（连翻照片时一条渲染崩溃不该弹窗）；但同一张图**第二次**渲染失败 → error T2（说明非偶发）。去重状态放 `useLumenPreview` 的 `attemptsRef`。

### 6.2 具体文案（≤ 2 行，`\n` 换行；对齐现有口吻）

| 编号 | 变体 | 文案 |
|---|---|---|
| T1 | info（未配置，点击入口时） | `尚未配置 LUMEN RAW 引擎。\n真实 RAW 预览与 AI 增强不可用，可在「设置」中启用并指定 CLI 路径。` |
| T2 | error（崩溃/渲染失败） | `LUMEN RAW 渲染无响应，已回退到内嵌预览。\n选片不受影响；引擎会在下次调用时自动重启。若反复出现，请在「设置」中检查 CLI 路径。` |
| T3 | info（版本漂移） | `LUMEN RAW 版本与宿主不匹配（需支持 edit.apply / render_preview 等命令）。\n相关功能已停用，请升级 LUMEN RAW 至 1.6.0 或更高。` |
| T4 | success（评级同步 P1） | `评级已同步到 LUMEN RAW：导出 X 张，导入 Y 张。` |
| T5 | warn 级 info（同步有冲突） | `评级同步发现 Z 处冲突（两边都改过）。\n请在「设置 → 同步评级」中逐张裁决，未冲突部分已完成同步。` |

### 6.3 不新增 toast 变体

现有三变体 success/error/info（Toast.tsx :12）+ 三色（:38-57）已够用：冲突场景（T5）直接用 info——非阻断原则优先，不引入 warn 级。

---

## 7. ShortcutHelp + useKeyboardShortcuts 加新键的结构

### 7.1 现有结构（三处必须同步）

| 文件 | 结构 | 行号 |
|---|---|---|
| `hooks/useKeyboardShortcuts.ts` | `KeyboardShortcutsProps` 接口（23 个回调，仅 4 个必需） | :3-21 |
| 同上 | `isDialogOpen()` 模态门控 + 输入框门控 | :51-52, :58-66 |
| 同上 | `switch (e.key)` 主分支 + `\\`/:`/`/`?` 前置分支 | :69-92, :94-234 |
| 同上 | keyup 只处理 `\\`（按住看原片） | :237-254 |
| `components/ShortcutHelpModal.tsx` | `GROUPS` 5 组（浏览/标记/视图/对比）+ 鼠标组 | :15-52, :54-58 |
| `components/BottomBar.tsx` | 精简键位条（1~5 / P / X / A D / C / Y / E / M / ?） | :63-94 |

### 7.2 新键候选与冲突裁定

**任务候选 E=AI增强 ❌ 不可行**：`E` 已被"调色面板"占用（:224-230 `onToggleTonalPanel`，且已外泄到三处 UI 文案：PreviewViewport :369、BeforeAfter :218、TopBar :297、ShortcutHelp :39、BottomBar :75）。改键会破坏用户既有肌肉记忆 + 五处文案。

| 功能 | 键位 | 裁定依据 | 阶段 |
|---|---|---|---|
| AI 增强一键触发 | **`Shift+E`** | 与 E（调色）同族不同动作；`e.shiftKey` 分支加在 :69 前置区，不碰 switch | P2 |
| 套用当前调色预览（recipe 渲染） | **`G`** | 全 switch 无 G；`g/G` case 加在 :230（E case）之后 | P1 |
| 深链打开 LUMEN RAW | `Shift+O` | O=外部打开（:151-155）的同族扩展 | P2 |

**结构写法**（仿 optional 回调模式 :10 + :167-171）：

```ts
// :20 后追加（接口）
onLumenEnhance?: () => void;      // Shift+E
onApplyLumenRecipe?: () => void;  // G
onLumenDeeplink?: () => void;     // Shift+O
// :92 前追加（前置分支，shift 类必须前置，switch 的 e.key 拿不到修饰键语义）
if (e.shiftKey && (e.key === 'E' || e.key === 'e') && onLumenEnhance) { e.preventDefault(); onLumenEnhance(); return; }
if (e.shiftKey && (e.key === 'O' || e.key === 'o') && onLumenDeeplink) { e.preventDefault(); onLumenDeeplink(); return; }
// switch 内 :230 后
case 'g': case 'G': if (onApplyLumenRecipe) { e.preventDefault(); onApplyLumenRecipe(); } break;
// :279 前 deps 数组同步加三项
```

**注册纪律**：P0 不注册任何新键；P1 只注册 G；P2 注册 Shift+E / Shift+O，**且仅当 `lumenStatus.available`**（App.tsx :680-698 调用处传 `undefined` 即为不注册，接口 optional 就是为此设计）。

### 7.3 ShortcutHelpModal / BottomBar 同步

ShortcutHelp GROUPS 新增组/追加两行：`{ keys: 'G', label: '套用当前调色生成 RAW 预览' }`（P1）、`{ keys: 'Shift+E', label: 'AI 增强（需 LUMEN RAW）' }`（P2），并把 `GROUPS` 常量改为 `buildGroups(lumenAvailable: boolean)`——不可用时整组不渲染（与徽标隐藏同理：不展示不可用的功能）。BottomBar :63-84 精简条**不加**（保持 6 个核心键，`?` 全览是既定信息架构，:59 注释）。

---

## 8. types/index.ts 的 camelCase 约定与新命令类型

### 8.1 两侧约定实测

| 侧 | 约定 | 证据 |
|---|---|---|
| 前端 `src/types/index.ts` | 全 camelCase 字段 | `baseName` :47 / `hasXmp` :47 / `thumbnailPath` :47 / `defaultJpgFolder` :51 |
| 前端 invoke 参数 | camelCase（Rust 侧 serde 接收） | api.ts :14-18 `jpgFolder` / `rawFolder` / `sortOrder` |
| Rust `src-tauri/src/models.rs` | `#[serde(rename_all = "camelCase")]` 逐结构体标注 | :4 / :14 / :28 / :36 / :47 / :64 |
| Tauri 命令命名 | `snake_case` + `_cmd` 后缀 | `scan_folders_cmd` :14、`update_rating_flag_cmd` :41 等 14 个 |

**铁律**：新字段/新命令严格遵循 —— TS 接口 camelCase、invoke 参数 camelCase、Rust 命令 snake_case+`_cmd`、Rust 结构体带 `rename_all="camelCase"`。

### 8.2 新增类型（追加在 types/index.ts :56 AppSettings 之后、:58 ExportItem 之前）

```ts
export type LumenBackend = 'editor' | 'sidecar' | 'none';

export interface LumenStatus {
  available: boolean;
  backend: LumenBackend;
  version: string;      // 握手实获（漂移检测用，README:9 Win 1.6.0 / Mac 1.5.2）
  reason?: string;      // 'not_configured' | 'handshake_failed' | 'version_drift' | 'disabled'
}

export interface LumenPreviewResult {
  previewUrl: string;   // 已 convertFileSrc 的 asset:// URL（api.ts :194 模式）
  width: number;
  height: number;
  cached: boolean;
}

export interface LumenRecipe {
  adjustments: Partial<Record<string, number>>;   // 见 §4.2：宿主只写 6 键交集
  masks?: Array<{ region: string; amount?: number }>;
}

export interface LumenRatingSyncResult {
  imported: number;
  exported: number;
  conflicts: Array<{ path: string; gallery: number; lumen: number }>;
}
```

### 8.3 既有类型的两处扩展

```ts
export interface AppSettings {           // :50-56
  // …既有 5 字段
  lumenEnabled: boolean;                 // 默认 false（关闭时零开销）
  lumenPath: string;                     // 空 = 自动探测
  lumenPreviewWidth: number;             // 默认 1600
}
```

**迁移注意**：`getSettings`（api.ts :139）读旧 SQLite 行时缺这三个键 → **Rust `db.rs` 侧给 Default**，前端 :81-85 的 `if (s.x)` 式判空已足够，不写迁移代码。

```ts
export interface PhotoGroupInfo {        // :35-48
  // …既有 12 字段
  lumenRecipe?: boolean;                 // P1：同名 .lumen 存在（驱动 L 角标）
}
```

**不加** `lumenRenderUrl`：URL 是易腐的运行时缓存（磁盘缓存可清理），进类型会造成"类型里有但文件已没了"的不变量破坏；放 hook 内 Map（§3.2）。

---

## 9. UI 层改动文件清单

| 文件 | 阶段 | 改动 | 行号锚点 | 侵入度 |
|---|---|---|---|---|
| `src/types/index.ts` | P0 | +5 类型；AppSettings +3 字段；PhotoGroupInfo +1 字段 | :50-56, :35-48 | 极低 |
| `src/services/api.ts` | P0 | +`lumenStatus`/`lumenRenderPreview`；P1 +3；P2 +2 | :5-197（对象内追加） | 低 |
| `src/hooks/useLumenPreview.ts` | **P0 新增** | 预览 URL 缓存 + loading/degraded + attemptsRef | — | 中（新文件隔离） |
| `src/hooks/useLumenStatus.ts` | **P0 新增** | 启动握手（App :115 定时器后调用）+ `{status, refresh}` | — | 中 |
| `src/components/LumenStatusBadge.tsx` | **P0 新增** | 三态圆点 + title 文案 + 点击进设置 | — | 低（< 60 行） |
| `src/components/PreviewViewport.tsx` | **P0** | :132-136 接 hook；loading 态；:187 filter 条件；onError 回退 | :132-136, :179-190 | 中 |
| `src/components/SettingsModal.tsx` | P0 | 引擎开关 + 路径 + 尺寸 + 握手状态行 | :124 后插入 | 中 |
| `src/components/TopBar.tsx` | P0 | +`lumenStatus`/`onOpenSettings` slot 徽标；P2 +深链按钮 | :262 动作区前端 | 低 |
| `src/App.tsx` | P0/P1/P2 | :680-698 注册新回调；:596-632 旁加 deep link handler；**不改 state 数量** | :680-698 | 中 |
| `src/components/BeforeAfterViewport.tsx` | P1 | after 源/`hasLumenRender`/toneFilter/头部文案 | :106-119, :156-158 | 中 |
| `src/components/TonalAdjuster.tsx` | P1 | 保存按钮 label/落点切换 | :225-240 | 低 |
| `src/utils/toneToRecipe.ts` | **P1 新增** | tone↔recipe 双向纯函数 + 夹取 | — | 低（含单测） |
| `src/components/ThumbnailGrid.tsx` | P1 | L 角标 + legend + description | :221-235, :493-530, :397-409 | 低 |
| `src/hooks/useKeyboardShortcuts.ts` | P1/P2 | +3 optional 回调 + 前置 shift 分支 + deps | :3-21, :92, :230, :279 | 低 |
| `src/components/ShortcutHelpModal.tsx` | P1/P2 | `GROUPS` → `buildGroups(lumenAvailable)` | :15-52 | 低 |

**总计**：新增 4 文件，改 11 文件；**App.tsx 只动 2 处**（符合"920 行少动"铁律）；`SplitCompareViewport.tsx` **P0/P1 零改动**。

---

## 10. step-by-step 实施步骤（每步 = 可验证动作 + 验收标准）

> 前置依赖：Rust 侧 `lumen_bridge.rs` + `lumen_status_cmd` / `lumen_render_preview_cmd` 已注册（计划 §2.1/2.2）。以下步骤纯前端，可独立验收。

### P0 阶段（真实 RAW 预览显示）

**步 1 · 类型与 api 打底**
- 动作：`types/index.ts` 加 §8.2 五类型 + §8.3 两处扩展；`api.ts` 加 `lumenStatus` / `lumenRenderPreview`（签名照 §2 表，参数 camelCase）。
- 验证：`npx tsc --noEmit` 零报错；grep `invoke<'` 计数 = 16（14 旧 + 2 新）。
- 验收：命令名与 Rust `lib.rs` `generate_handler!` 注册名逐字一致（大小写不匹配是 Tauri 静默失败首因）。

**步 2 · 握手 hook 与徽标**
- 动作：新增 `useLumenStatus.ts`（启动 1500ms 后调 `lumenStatus`，仿 App :115 定时器不阻塞首屏）+ `LumenStatusBadge.tsx`；`TopBar.tsx` 在 :262 动作区前端插 slot；App :680 区把 `onOpenSettingsModal` 透传。
- 验收：① sidecar 未配置 → 徽标灰 + title 显示 T1 首句；② 配置后点徽标进设置、保存返回 → 徽标变绿（`backend:'sidecar'`）；③ `lumenEnabled=false` → 徽标完全不渲染，且 network/invoke 面板**零** `lumen_*` 调用。

**步 3 · 使用 hook 组件**
- 动作：新增 `useLumenPreview.ts`（输入 group；`group.jpg` 存在直返；RAW_ONLY 且 available → `lumenRenderPreview(raw.path, lensPreviewWidth)`；`attemptsRef` 记失败次数；降级 `src = toAssetUrl(raw.path)`）。
- 验收：hook 单测/手测四种输入（JPG 组 / RAW_ONLY+available / RAW_ONLY+不可用 / 切换 group）输出正确；切 group 时 URL 缓存按 `group.id` 失效（防串图，F-03 类回归）。

**步 4 · 接入使用 hook**
- 动作：`PreviewViewport.tsx` :132-136 改调 hook；:179 `<img>` 前加 loading 分支；加 `onError` → 回落；:187 filter 在 `lumen 预览成功` 时置 `'none'`；`onImageElement` :180 保留。
- 验收：① ARW 文件夹单图显示真实解码预览（对比：今天此处是破图/空白）；② lumen 渲染超过 `getToneFilterString` 调色时画面不被 filter 二次叠加；③ 杀掉 sidecar 进程后继续翻页不白屏、不弹 toast，回落内嵌 JPEG/旧路径。

**步 5 · SettingsModal 引擎块**
- 动作：在 :124 后插入 §5.1 五控件；browse 仿 :34-44（exe 过滤）；保存后 `onSettingsSaved` :51 已把新 settings 推回 App :874。
- 验收：① 保存→重启→`getSettings` 带回三新字段（默认 `lumenEnabled:false` 时不发任何 lumen 请求）；② 握手状态行显示 `available/backend/version` 三元组；③ 填错路径保存 → 徽标灰、title = T2 首句，无未捕获异常。

**步 6 · P0 整体验收（对应计划 §2.4）**
- 验收：RAW_ONLY 文件夹冷启动到首张预览 < 3s、热切换 < 1s（1600px，中端机）；lumen 关闭时逐项行为与今天一致；全程无 `error` toast（未配置仅 info）。

### P1 阶段（recipe 显示/回传 + 评级同步）

**步 7 · recipe 双向纯函数**
- 动作：新增 `utils/toneToRecipe.ts`（§4.2 映射 + §4.3 exposure 范围统一到 -5..+5，需先改 `TonalAdjuster.tsx` :49-50 与 types :27 注释）。
- 验收：单元测试覆盖 6 字段往返（tone→recipe→tone 恒等）；exposure ±5 不被夹断；temperature 按 `edit.get` 实返词表校准量纲（§4.3-2 未闭环前**禁止开启**色温同步，先只透传另外 5 个 + 文案注明）。

**步 8 · 调色面板落点切换**
- 动作：`TonalAdjuster.tsx` :225-240 保存按钮按 `lumenStatus.available` 切 label（"同步 XMP" ↔ "套用到 LUMEN RAW"）+ 切 `onSaveXmp` 落点；App `handleSaveToneToXmp` :570-593 内部分支。
- 验收：lumen 可用时点保存 → `.lumen`/recipe 生效（用 lumen GUI 打开同目录验证）；不可用时点保存 → 仍写 crs:* XMP（Lightroom 兼容不回归）；按钮 disabled/反馈态（:227-239）不变。

**步 9 · 前后对照接 recipe**
- 动作：`BeforeAfterViewport.tsx` 按 §3.3 改 `hasLuminarRender` / after 源（含 before 侧同源 RAW 无 recipe 渲染）/ :118-119 filter / :156-158 文案；成功后 App 侧仿 :620 切 Y 视图。
- 验收：① 有 `.lumen` 的照片按 Y → 左为无 recipe 渲染、右为带 recipe 渲染，**左右同源同尺寸**（不是"内嵌 JPEG vs lumen"）；② 无 recipe 时行为与今天逐像素一致（CSS filter 路径未被破坏）。

**步 10 · 评级同步 + 宫格 L 角标**
- 动作：`handleRate` :443 / `handleFlag` :465 的 try 内追加 `api.lumenSyncRatings` 单发（Option B），失败走独立 `reportLumenSyncError`（不混入 :422 XMP 文案）；`ThumbnailGrid` 按 §3.4 加 L 角标 + legend + description；SettingsModal 加手动同步按钮（§5.1 末行）。
- 验收：① Gallery 打 3 星 + P → lumen GUI 同目录立可见（反之亦然）；② 同步失败时星标仍在（乐观更新不回滚）且 toast 文案指向"检查 lumen 安装"而非"XMP 权限"；③ 有 `.lumen` 的缩略图显示 L 角标，屏幕阅读器播报"含 LUMEN 调色"；④ 徽标/角标/lumenEnabled=false 三者组合无异常。

**步 11 · G 键与帮助面板**
- 动作：`useKeyboardShortcuts` 按 §7.2 加 `G`（P1 注册）与 optional `onApplyLumenRecipe`；App :680-698 传 handler（= 步 8 的保存+切视图合体）；`ShortcutHelpModal` GROUPS 改 `buildGroups(lumenAvailable)`。
- 验收：按 G → 当前 recipe 渲染并切 Y 视图；lumen 不可用时按 G **无任何反应**（handler 传 undefined）且帮助面板无该行。

### P2 阶段（AI 增强 + 深链）

**步 12 · AI 增强入口（Shift+E）**
- 动作：`api.lumenEnhance`；App 加 `handleLumenEnhance`（仿 §1.3 八步）；入口 = TopBar :323 后按钮 + PreviewViewport :394 前按钮 + `Shift+E`（仅 available 时注册）；产物 DNG 复用 E 角标（title :524 改文案）。
- 验收：① 点增强 → busy 态（照抄 :382 disabled + spin :388）→ 完成后自动切 before_after 且 E 角标出现；② 增强失败 toast 带"模型权重首次使用需下载"提示（README:229 的 830MB 首次下载事实）；③ 杀 worker 进程 → 编辑器不崩，回退提示（lumen AI 模型独立进程，README:193）。

**步 13 · 深链"在 LUMEN RAW 中编辑"**
- 动作：`api.lumenDeeplink`；三处按钮（§5.2）；App handler 仿 :596-632 但**不拼假 `PhotoFileInfo`**（§1.3 步骤 3 的坑：mtime/size 重新 stat）。
- 验收：① lumen GUI 活着 → 照片在其中打开（Option C 命名管道）；② 没活 → toast T2 变体「请先启动 LUMEN RAW，或导出后用其它程序打开」，宿主不阻塞；③ 深链期间按快捷键不串（`isLumenBusy` 不做全局锁——选片心智优先，允许边等边翻）。

**步 14 · 终局验收（三阶段合并回归）**
- 验收：① lumen 关 → 全应用行为与集成前基线逐屏一致（截图 diff）；② lumen 开 → P0/P1/P2 十三步验收项全绿；③ 快捷键 `?` 面板与实际注册一致（无死键、无冲突键）；④ 崩溃注入（杀 sidecar / 杀 worker / 拔路径）下零白屏零未捕获 reject。

---

## 11. 前端/UX 域风险登记

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 1 | exposure 范围三处不一（UI -3 / 注释 -5 / lumen 无约束，§4.3） | 回传被夹断，"套用没反应" | 步 7 统一到 -5..+5 |
| 2 | temperature 量纲（绝对 K vs 相对偏移，§4.3-2） | 色温放大数百倍，画面偏色离谱 | 未闭环前不透传该字段 |
| 3 | E 键冲突（任务候选 vs 现状 :224-230） | 改键破坏肌肉记忆 + 五处文案 | 改判 Shift+E（§7.2） |
| 4 | 920 行 AppShell 上下文漂移 | 历史上 F-01/02/03/04/05/12/15/18/25 皆源于此 | 新状态全进 hook（§1.1 结论） |
| 5 | recipe 词表版本漂移（lumen 迭代增删滑块名） | `recipeToTone` 遇未知键 | `Partial<Record>` + 未知键忽略 + 徽标版本提示（T3） |
| 6 | 预览磁盘缓存无限增长（每次渲染落文件） | 磁盘占满 | Rust 侧 LRU 清理（计划已列）；前端 `cached` 标志可做"已缓存则不重请求" |
| 7 | RAW+JPG 并存时体验分裂（宫格内嵌 JPEG vs 大图 lumen） | "选片看到一套色、放大变另一套" | 默认仍 JPG 优先（速度优先），仅 RAW_ONLY 或显式开启时用 lumen；前后对照保证同源（步 9） |
| 8 | "LUMEN RAW" vs "Luminar AI" 命名混淆（现有 :384/:313 等 6 处） | 用户点错 | 文案严格区分，深链按钮加副标题"RAW 解码与调色引擎" |

---

*（报告完 — 前端/UX 集成面 8 课题全覆盖；宿主仓库只读，未做任何修改。）*

