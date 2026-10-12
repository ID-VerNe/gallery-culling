# B — RAW 解码 / 渲染 pipeline ↔ 宿主缩略图与大图预览

> 比对对象：宿主 `gallery-flask`（Tauri 2.0 + Rust + React）↔ 客体 `lumen-raw` v1.6.0（commit `43b4ebe`）。
> 集成决策前提：进程级 sidecar 混合桥接（A. `lumen-cli mcp` 常驻 stdio 主循环；B. `lumen-cli run` 单发重活）。两仓库只读，本文所有行号对应该 commit。


## 0. 结论摘要（TL;DR）

1. **宿主今天没有 RAW 解码能力**：`Cargo.toml:29-40` 的 `image` crate 只启用 `jpeg/png/webp`，`thumbnail.rs` 的两条路（EXIF 内嵌 JPEG、`image::open` 全图 fallback）都解不了 ARW/CR2/NEF；大图预览 `PreviewViewport.tsx:132-136` 更是直接把 `.arw` 路径交给 webview 渲染 → RAW-Only 组大图必然裂图。宿主缩略图能用，靠的是 `thumbnail.rs:90-118` 从 RAW 里**抠相机内嵌 JPEG**（相机自己的显影结果）。
2. **lumen 是一条完整的浮点线性管线**（`engine.py:126-198` 解码 → `engine.py:896-953` process），预览输出是**已经转正（upright）且不含 EXIF orientation 标签**的 sRGB JPEG（`commands.py:507-537`）。**集成后宿主绝不能再做一次方向校正**（见 §6）。
3. **契约核心**：宿主不需要自己拼 pipeline，只需要 `render_preview`/`get_edits`/`apply_edits` 三个 MCP 工具 + `photo.open`；重活（全尺寸导出）走 `lumen-cli render` 单发。
4. **缓存 key 必须换目录+换前缀**：`app_cache/lumen/` + `lumen-preview-v1` 前缀 + `_lumen` 后缀，且把**同名 `.lumen` 工程的 mtime 纳入 key**（headless 会话会自动拾取兄弟工程，见 §3/§4）。
5. **色调单位陷阱**：宿主 XMP 写**绝对色温 K**（`xmp.rs:175-177`），lumen 的 `adjustments.temperature` 是**相对 as-shot 的偏移量 -100..100**、绝对 K 在 `white_balance.kelvin`。两者不可 1:1 搬运（§5 映射表已标注）。
6. **定位建议**：P0 大图换 lumen 渲染、调色 UI 只读显示（保留现有 CSS filter 作无渲染时的即时近似，但**不能与 lumen 渲染叠加**）；P1 宿主直接写 lumen recipe。

---

## 1. File-by-file 比对表

| 侧 | 文件 | 在本领域的职责 | 集成影响 |
|---|---|---|---|
| Host | `src-tauri/src/thumbnail.rs` | 缩略图缓存 + EXIF 内嵌 JPEG 提取 + 方向校正 + SIMD 缩放 | 保留原样（JPG/PNG/WebP 快路径不变）；新增 lumen 分支 |
| Host | `src-tauri/src/scanner.rs` | 扫盘配对、EXIF 读取、XMP 色调回读（`:54-73`） | `RAW_EXTENSIONS`（`:11-13`）比 lumen `RAW_EXTENSIONS`（`engine.py:32`）少 `.rwl/.raw/.srf/.nrw` 等，需对齐 |
| Host | `src-tauri/src/commands.rs:29-37` | `get_thumbnail_cmd(file_path, width)` → `spawn_blocking` → `get_or_create_thumbnail` | 旁边新增 `lumen_preview_cmd`，旧命令不动 |
| Host | `src/services/api.ts:24-30` | `getThumbnail` → `invoke` → `convertFileSrc` | 新增 `getLumenPreview`；`convertFileSrc` 流程复用 |
| Host | `src/components/PreviewViewport.tsx` | 大图渲染 + zoom/pan + CSS filter（`:187`） | RAW 源改成 lumen 预览 URL；filter 逻辑改为“无 lumen 渲染时才用” |
| Host | `src/components/BeforeAfterViewport.tsx:119` | 对比视图同样用 CSS filter | 同 PreviewViewport 一起改 |
| Host | `src/utils/autoTone.ts` | canvas 直方图 auto-tone（`:16-144`）+ CSS filter 串（`:149-192`） | P1 可被 lumen `image_statistics`（`nl_edit.py:458-487`）替代/互校 |
| Host | `src-tauri/src/models.rs:35-44` / `src/types/index.ts:26-33` | `ToneAdjustments` 6 字段 | P1 映射源，见 §5 |
| Host | `src-tauri/src/xmp.rs:165-183` | crs:* 色调写入口 | 不做结构改动；P1 需补绝对色温换算 |
| Guest | `lumen/engine.py:126-198` | 16-bit 线性解码（`load_image`） | **宿主侧完全不碰**，只经 MCP/CLI 调用 |
| Guest | `lumen/engine.py:896-953` | `process()` 显影主链（v1/v2） | 同上 |
| Guest | `lumen/develop.py:16-54` | 相机参考曲线（内嵌 JPEG 分位拟合） | 决定“显影起点”，宿主只读展示 |
| Guest | `lumen/previews.py:30-49,172-174` | 内嵌预览的方向处理 | §6 双校正风险的关键 |
| Guest | `lumen/commands.py:507-537` | `render.preview`（I/O 契约本体） | §3 |
| Guest | `lumen/cli.py:89-115` | `lumen-cli render` 单发重活 | §3.3 |
| Guest | `lumen/mcp.py:41-55,160-194` | MCP 工具清单 / `tools/call` 分发 | §3.2 |
| Guest | `lumen/model.py:33-190` | Recipe schema + validate | §5 |
| Guest | `lumen/session.py:92-105` | headless 会话：懒解码 + 兄弟 `.lumen` 工程拾取 | §4 缓存 key 必须含工程 mtime 的原因 |
| Guest | `lumen/white_balance.py:26-48` | exiftool 子进程取元数据 | §8 风险：每次 photo.open 的成本 |
| Guest | `lumen/curves.py` / `lumen/exposure_curve.py` | 曲线求值 / 曝光曲线联动 | 仅影响 §5 曲线字段语义 |

---

## 2. 解码链路比对（宿主今天能干什么 / 不能干）

### 2.1 宿主链路 `thumbnail.rs`

```
get_or_create_thumbnail(path, width)            # :149
 ├─ read_orientation(path)                       # :27   EXIF Orientation 1..8（kamadak-exif）
 ├─ get_cache_path(abs, mtime, width, orient)    # :59   SHA256(abs-mtime-width-orient-"thumb-v2")
 ├─ [命中] cache 存在且 mtime>=源 → 直接返回        # :157-168
 ├─ try_extract_exif_thumbnail(path)             # :90   读 IFD(THUMBNAIL) JPEGInterchangeFormat/Length → seek 读原始字节
 │    └─ image::load_from_memory(jpeg)           # :172  image crate
 │        ├─ apply_orientation(img, orient)      # :173  物理旋转（:45）
 │        └─ resize_simd(&img, width)            # :174  fast_image_resize U8x3（:121）
 │            └─ save JPEG → cache_path          # :176
 └─ [fallback] image::open(path)                 # :183  ← ★ 只有 jpeg/png/webp 特性
      ├─ apply_orientation(...) → resize_simd(...) → save JPEG
```

**今天能干的**
- JPG/PNG/WebP：完整链路（含 8-bit 解码、方向、缩放、落盘、缓存）。
- RAW：**只能走内嵌 JPEG 预览**。多数相机 RAW 的 IFD1 里有 160–1620px 的 JPEG，所以网格里 RAW 有图；内容 = 相机自己的显影（相机白平衡 + 机身风格），**不是 lumen 的显影**。
- 方向：已完整实现 `read_orientation` + `apply_orientation`（`thumbnail.rs:27-56`），且缓存 key 含 orientation（`:70-76`）。

**今天不能干的（= lumen 进场后补的）**
| 缺口 | 证据 | 后果 |
|---|---|---|
| 无 full-size RAW 解码 | `Cargo.toml:29` `features = ["jpeg","png","webp"]`，无 `tiff/raw` | `thumbnail.rs:183` `image::open` 对 `.arw/.cr2/.nef` 直接报错；`.tif/.tiff` 同样不支持 |
| 大图预览根本没有 RAW 通路 | `PreviewViewport.tsx:132-136` 把 `group.raw.path` 直接 `toAssetUrl` | webview 解不了 ARW/CR2/NEF → RAW-Only 组大图裂图（JPG+RAW 完整组靠 JPG 兜住，掩盖了问题） |
| 无“显影”概念 | 全链路都是 decode→resize→encode | 相机内嵌 JPEG ≠ lumen 显影；recipe 完全无法影响预览 |
| 无 16-bit / 线性光 | `resize_simd` 固定 `U8x3`（`:133`） | 无法承接 lumen 的 float32 线性域 |
| 无曲线/HSL/分级/蒙版 | — | 宿主 6 个 CSS 近似参数（`autoTone.ts:149-192`）就是天花板 |

### 2.2 lumen 链路 `engine.load_image`（`engine.py:126-198`）

```
load_image(path, preview_limit=1600, develop_reference=False, clip=False)
 ├─ .dng 且已渲染（dng.is_rendered）→ dng.read 16-bit 线性
 ├─ RAW 后缀（engine.py:32 的 RAW_EXTENSIONS）
 │   ├─ white_balance.metadata(path)            # :144  exiftool 子进程（§8 风险）
 │   ├─ NEFCompression 13/14 → load_embedded()  # :146  相机全尺寸 JPEG 兜底（:270-298）
 │   └─ rawpy.imread → unpack
 │       ├─ info width/height（flip 5/6 换宽高）= 转正后尺寸      # :153
 │       ├─ camera_matrix / xyz_to_camera → 色彩矩阵               # :156,158
 │       ├─ camera_wb_gains / lens_info / photo_metadata          # :161-162
 │       └─ raw.postprocess(use_camera_wb=True, no_auto_bright=True,
 │              output_bps=16, gamma=(1,1),                        # :166
 │              output_color=sRGB if 无矩阵 else raw,
 │              half_size=bool(preview_limit), user_flip=None,     # ← 见 §6
 │              highlight_mode=Blend)
 │           → astype(float32) /= 65535                             # :170  ★16-bit→float32 线性
 │           → camera_to_srgb(rgb, conversion, clip)               # :172  相机 RGB→线性 sRGB（float，负值保留给 v2）
 │           → develop.camera_curve(raw, clip(resize_limit(rgb,800),0,1), path)  # :174  ★相机参考曲线
 ├─ .tif/.tiff/.png 16-bit → cv2.imdecode + to_linear（无 exif_transpose！:177-192）
 ├─ 其它 8-bit → load_pillow（exif_transpose + ICC + to_linear）    # :301-319
 └─ large_image.validate_size + resize_limit(rgb, preview_limit)   # :197-198  INTER_AREA 缩到 1600
```

**关键差异**
- lumen 全程 **float32 线性光**，sRGB 化只发生在显影末端；宿主是 **8-bit sRGB**（`U8x3`）。
- lumen 的 `develop.camera_curve`（`develop.py:16-54`）用 13 个分位点把**线性亮度**对齐到**相机内嵌 JPEG 的亮度**（锚点 `[0,0]`/`[1,1]` + 单调保护），保证 RAW 显影起点与相机观感一致；拿不到内嵌 JPEG 时退化为“标准亮度”（`:50-54`）。宿主完全没有对应物。
- lumen `preview_limit=1600` 是**解码即降采样**（`half_size=True` 走 LibRaw 半尺寸 + `resize_limit`），比宿主“全尺寸解码再缩”快一个量级。
- 解码结果由 `session.py:92-105` **常驻内存**（每张 1600px 3:2 ≈ 1600×1067×3×4B ≈ **20MB**），后续 `render.preview` 直接复用——这是“预览主循环”性能的根基，也是 §8 的内存预算问题。

---

## 3. 渲染 preview 的输入输出契约 + 新缓存 key 设计

### 3.1 lumen `render.preview`（`commands.py:507-537`）

```
render.preview 参数（mcp.py 工具名 render_preview；commands.py:524-528 的 schema）
  path      string   照片路径；省略 = 当前照片（内部会 photo.open）
  size      int      长边像素，**128..2048**，默认 1024
  original  bool     true = 未编辑的“显影原片”（develop_view），默认 false
  output    string   可选：把 JPEG 同时写到该文件（★宿主缓存的关键）

返回（commands.py:536-537）
  { path, width, height, mime:"image/jpeg",
    image: <base64 JPEG>,        ← MCP 会拆成 image content block（mcp.py:190-192）
    statistics: {...},           ← nl_edit.image_statistics 文本统计（:458-487）
    output }

内部：preview_image(:507-514) → session source（1600px 解码）
      original=True  → engine.develop_view(source, edits)         # engine.py:261-267
      original=False → crop_rotate(engine.process(source, edits, backend, apply_crop=False), edits)
      → resize_limit(rgb, size)  # 只缩不放（size>1600 时输出就是 1600px）
      → jpeg(rgb, quality=88)    # :517-521 PIL 编码，**不写 EXIF**
```

**宿主侧直接结论**
- `size` 上限 2048、源上限 1600 ⇒ **宿主 preview 与缩略图共用一次解码**，`width=1600` 是性价比最高的一档（大图 viewport 够用）。
- 传 `output` 让 lumen **直接写盘**，宿主免去 base64 解码落盘；但 MCP 响应里仍会带 base64（`commands.py:537` 无条件），Rust 侧直接忽略该字段即可。
- `original=true` 与 `false` 是**两种不同缓存**（显影原片 vs 编辑后）必须分开 key。

### 3.2 MCP 通路（`mcp.py`）— 预览主循环

传输：stdio 上**逐行 JSON-RPC 2.0**（`mcp.py:97-101, 102-118`）；stdout 只走协议，库的任何 print 被重定向到 stderr（`:205-208`）。
握手：`initialize`（旧版 2024-11-05…2025-11-25）或 `server/discover`（2026-07-28，`_meta` 带版本）；`tools/list` 拿工具表；`tools/call` 分发。
**宿主应发的最小序列**：

```jsonc
// 1) 握手（legacy 路径，最稳）
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}
// 2) 打开照片（headless 会话懒解码 1600px）
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"open_photo","arguments":{"path":"D:\\ shoot\\IMG_0001.arw"}}}
// 3) 读 recipe（含完整 recipe：P1 用）
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_edits","arguments":{"full":true}}}
// 4) 渲染预览并直接落盘（★宿主缓存）
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"render_preview",
  "arguments":{"path":"D:\\shoot\\IMG_0001.arw","size":1600,"original":false,
               "output":"C:\\\\...\\\\app_cache\\\\lumen\\\\<hash>_IMG_0001_1600_lumen.jpg"}}}
```
注意：`render_preview` 是 **readOnlyHint** 工具（`commands.py:527`），语义安全；`apply_edits` / `set_process_version` 会改会话内 recipe（headless 下仅存于 sidecar 进程内存，除非 `save_project`）。
**lumen-cli 的 `--headless` 必须锁定**：`Dispatcher`（`mcp.py:58-84`）默认会尝试连接本机正在运行的 lumen GUI（`control.Client`）并把编辑推到 GUI 上当 undo step——宿主应始终传 `--headless`（`cli.py:158-159`）。

### 3.3 单发通路（`cli.py:89-115`）— 重活

```
lumen-cli render INPUT OUTPUT [--size N] [--quality Q] [--preset NAME] [--amount P]
                     [--set k=v ...] [--process 1|2] [--overwrite]
```
`--set` 支持点号嵌套（`cli.py:104-111`：`hsl.blue.saturation=20`、`effects.vignette=-20`）；最终走 `photo.export`（`commands.py:543-569`，`long_edge`/`quality`/格式由扩展名决定，**永不覆盖原图**）。
适合：全尺寸导出、批量导出（`lumen-cli run photo.export_batch`）。

### 3.4 新 lumen 缓存 key 设计

旧宿主 key（`thumbnail.rs:59-87`）：
```
key = "{abs}-{mtime}-{width}-{orientation}-thumb-v2"        # SHA256 → hash[..16]
file = {hash16}_{stem}_{width}_rot{orientation}.jpg          # 落 app_cache/
```

**新 key（不与旧 key 冲突的三重隔离）**：

```
目录  : get_cache_dir().join("lumen")                        # 与旧文件物理隔离
前缀  : "lumen-preview-v1|{LUMEN_VERSION}"                   # 桥接/配方版本号
key   = "lumen-preview-v1|1.6.0|{abs}|{src_mtime}|{project_mtime}|{width}|{variant}"
file  = {hash[..16]}_{stem}_{width}_lumen_{variant}.jpg
```

- `variant ∈ {edited, original}`：`render.preview` 的 `original` 开关，**两者不可共用缓存**。
- `project_mtime`：**兄弟 `.lumen` 工程的 mtime**（不存在记 `0`）。必须纳入——headless `Session.open`（`session.py:66-90`）会自动拾取同名 `.lumen` 工程，recipe 的实际来源是它；只 hash 源文件 mtime 会导致“改完工程缓存不失效”。
- `LUMEN_VERSION`（`1.6.0`，`lumen/__init__.py:3`）：配方/管线跨版本变化时整体失效，防止 1.6→1.7 显影差异被旧缓存掩盖。
- `orientation` **不进 key**：lumen 输出已转正（§6），旧 key 的 `rot{orientation}` 后缀一并去掉，换成 `_lumen`——三重隔离（目录 + 前缀串 + 文件名后缀）保证与旧缓存零碰撞。
- 若 P1 要让宿主**即时传 edits**（UI 拖动实时渲染）而不是读 `.lumen`，则 key 的 `{variant}` 换成 `recipe-{blake2b16(canonical_json)}`：
  - canonical JSON 用 `edit.get full=true` 的返回（`commands.py:362-363` 已剔除 `masks[].raster/strokes`）；
  - **序列化前必须 key-sort + float 归一**（建议让 lumen 侧算，或 Rust 侧把 `serde_json::Value` 过一遍 `BTreeMap`），否则同一 recipe 两次渲染 key 不同 → 缓存永远 miss；
  - 该模式下 P2 若开放蒙版编辑，需把 raster 也纳入 hash（见 §8 风险 R6）。

---

## 4. 缓存落盘路径

### 4.1 现状

| 项 | 现状 | 代码 |
|---|---|---|
| 缓存根 | `./app_cache`（**相对 CWD**），创建失败退 `temp_dir()/gallery_culling_cache` | `thumbnail.rs:10-24` |
| 文件名 | `{hash16}_{stem}_{width}_rot{orientation}.jpg` | `thumbnail.rs:85` |
| 命中判定 | 文件存在 + `cache_time >= orig_time` + `len>0` | `thumbnail.rs:157-168` |
| 命令出口 | `get_thumbnail_cmd` → `spawn_blocking`（不阻塞 UI 线程） | `commands.rs:29-37` |
| 前端取图 | `api.getThumbnail(path, 200)` → `invoke` → **`convertFileSrc(本地路径)`** | `api.ts:24-30`、`ThumbnailGrid.tsx:374-387` |
| 大图取图 | `api.toAssetUrl(group.jpg.path ?? group.raw.path)`（**没有缩略图/渲染步骤**） | `PreviewViewport.tsx:132-136`、`api.ts:194-196` |

`convertFileSrc` = Tauri 的 asset 协议，把本地路径变成 `http://asset.localhost/...`，webview `<img src>` 零拷贝读盘。**lumen 预览只要写成 JPEG 文件就自动获得同款通路**，这是选“落盘 + 返回路径”而不是“base64 回传”的根本原因。

### 4.2 目标方案

```
get_cache_dir()                      # thumbnail.rs:10-24 不动
├── {hash16}_{stem}_{w}_rot{n}.jpg   # 旧：JPG/PNG/WebP 快路径（含 RAW 内嵌 JPEG）
└── lumen/                            # ★新子目录
    ├── {hash16}_{stem}_{1600}_lumen_edited.jpg    # 大图/调色预览
    ├── {hash16}_{stem}_{200}_lumen_edited.jpg     # 网格（可选档）
    └── {hash16}_{stem}_{1600}_lumen_original.jpg  # original=true（before/after 基准）
```

要点：
1. **`app_cache/lumen/` 子目录**即可，不引入平台目录：`app_cache` 的 CWD 语义与 `convertFileSrc` 行为完全一致（都在进程工作目录下），旧缓存逻辑零改动；若将来要迁 `AppData`，两套一起迁。
2. **原子写**：lumen 的 `output` 是整体 `write_bytes`（`commands.py:534`），但宿主仍应“写临时名 → `fs::rename`”，或至少写完后做一次 JPEG 魔数/长度校验；否则中断的半成品文件会让后续 `cache_path.exists()` 命中一张坏图。
3. **尺寸分档建议**：`1600`（大图 + recipe 渲染）、`200`（网格，仅当该 RAW 无内嵌 JPEG 或用户开启“lumen 缩略图”时）。两档各一份文件，key 只差 width。
4. **清理策略**：旧缓存没有 LRU/上限管理（只有 mtime 失效），lumen 目录同样先不做上限，但**每次启动可扫 `lumen/` 删 7 天前文件**（与 lumen 会话无关，纯 Rust 侧）。
5. **`convertFileSrc` 的路径分隔符**：Windows 下 `PathBuf::to_string_lossy()` 已是 `\`，与旧路径行为一致，无新风险。

---

## 5. Recipe schema 比对（字段级映射表）

### 5.1 两侧全集

**lumen `model.recipe()`（`model.py:33-41`）字段全集**（`validate` 的值域见 `model.py:58-190`）：

| 字段 | 默认/值域 |
|---|---|
| `version` | 6（1.6.0 起含 `process`） |
| `process` | 2（新照片）；1=1.0–1.5 旧管线，位兼容保留 |
| `develop` | `{mode: camera\|linear, curve: [[x,y]…], source: 标签}`；curve 2–32 点、单调 |
| `adjustments` | 16 项：`exposure(-5..5 EV), temperature, tint, contrast, shadows, highlights, blacks, whites, saturation, vibrance, dehaze, clarity, texture, sharpness, denoise, color_noise`（除 exposure 外 -100..100） |
| `curve_mode` | `linear\|smooth`（3 之前版本工程默认 linear） |
| `hsl` | 8 色 × 3（红橙黄绿青蓝紫洋红 × hue/sat/lum，各 -100..100） |
| `curves` | `{RGB,R,G,B}`，各 2–256 点 |
| `tone_curve` | 曝光曲线精细补偿，2–256 点（1.4.1） |
| `masks` | ≤32；kind ∈ brush/linear/radial/luminance/sky/person/background/color/subject/foreground；AI 类带 `raster` |
| `crop` | `[a,b,c,d]` 0..1 或 null |
| `rotation` | 0..3（90° 步进） |
| `straighten` | -15..15° |
| `monochrome` | bool |
| `wb_gain` | 3 通道，0.125..8 |
| `grading` | `{shadows/midtones/highlights: [hue 0..360, sat 0..100], balance -100..100}` |
| `effects` | `{vignette -100..100, midpoint, feather, grain, grain_size 0..100}` |
| `retouch` | ≤500 笔划（heal/clone） |
| `white_balance` | `{camera_kelvin, kelvin 1500..25000（成对）, estimated}` |
| `lens` | `{enabled, distortion 100=关, vignetting 100=关, chromatic, manual?, profile?}` |
| `watermark` | 水印 |

**宿主 `ToneAdjustments`（`models.rs:35-44`）全集 = 6 项**：`exposure, highlights, shadows, temperature, tint, contrast`。XMP 出口固定 6 个 crs 标签（`xmp.rs:165-183`）。

### 5.2 字段级映射表

图例：✅ 可互转（同单位/同刻度）｜🟡 近似互转（数值可搬、观感不同）｜⚠️ 需换算｜❌ 仅 lumen｜➖ 仅 host

| 域 | 宿主字段 | 宿主 XMP 出口 | lumen 字段 | 判定 |
|---|---|---|---|---|
| 亮度 | `exposure` | `crs:Exposure2012` `{:+.2}` | `adjustments.exposure`（EV -5..5） | ⚠️ 同为 EV 刻度但**核不同**：lumen 在线性光乘 `2^exposure`（`engine.py:521-524`），宿主 CSS 是伽马域 `brightness()`（`autoTone.ts:165`）。数值可搬、以 lumen 为准更正确 |
| 曲线 | — | — | `curves{RGB,R,G,B}` + `curve_mode` + `tone_curve` | ❌ 仅 lumen |
| HSL | — | （LR 有 `crs:HueAdjustment*`，宿主未写） | `hsl` 8×3 | ❌ 仅 lumen |
| 分级 | — | — | `grading` 3 轮 + `balance` | ❌ 仅 lumen |
| 暗角 | — | — | `effects.vignette/midpoint/feather` | ❌ 仅 lumen |
| 颗粒 | — | — | `effects.grain/grain_size` | ❌ 仅 lumen |
| 黑白 | — | — | `monochrome` | ❌ 仅 lumen |
| 清晰度/纹理 | — | — | `adjustments.clarity/texture` | ❌ 仅 lumen（空间邻域算子 `engine.py:577-604`） |
| 降噪 | — | — | `adjustments.denoise/color_noise` | ❌ 仅 lumen |
| 去雾/锐化 | — | — | `adjustments.dehaze/sharpness` | ❌ 仅 lumen |
| 饱和度/自然饱和度 | — | — | `adjustments.saturation/vibrance` | ❌ 仅 lumen |
| 黑/白场 | — | — | `adjustments.blacks/whites` | ❌ 仅 lumen |
| 高光 | `highlights` | `crs:Highlights2012` `{:+.0}` | `adjustments.highlights` | 🟡 近似：lumen 用 `p³` 权重 × stops/65（`engine.py:528-530`）；宿主只进 brightness 微调。host→lumen 直接搬，lumen→host 丢信息 |
| 阴影 | `shadows` | `crs:Shadows2012` `{:+.0}` | `adjustments.shadows` | 🟡 近似（`(1-p)²` 权重） |
| 对比度 | `contrast` | `crs:Contrast2012` `{:+.0}` | `adjustments.contrast` | 🟡 近似：lumen `(x-.5)*(1+c/125)+.5`（`engine.py:534-535`）vs 宿主 `1+c/100*0.35`（`autoTone.ts:168`） |
| 色温 | `temperature` | `crs:Temperature` **绝对 K** | `adjustments.temperature`（相对 as-shot -100..100）+ `white_balance.{camera_kelvin,kelvin}`（绝对 K） | ⚠️⚠️ **单位不同、不可 1:1**，见 §5.3 |
| 色调 | `tint` | `crs:Tint` `{:+.0}` | `adjustments.tint` | ✅ 可互转（同为绿-洋红偏移，正=洋红） |
| 镜头校正 | — | — | `lens{enabled,distortion,vignetting,chromatic}` | ❌ 仅 lumen |
| 裁剪/旋转/拉直 | — | — | `crop/rotation/straighten` | ❌ 仅 lumen（宿主 zoom/pan 是显示态 `PreviewViewport.tsx:184-186`，非 recipe） |
| 蒙版 | — | — | `masks[]`（AI region sky/person/subject/background/foreground/color + 亮度/渐变/画笔） | ❌ 仅 lumen |
| 修复 | — | — | `retouch[]` | ❌ 仅 lumen |
| 水印 | — | — | `watermark` | ❌ 仅 lumen |
| 显影起点 | — | — | `develop{mode,curve,source}` + `process` | ❌ 仅 lumen |
| 白平衡增益 | — | — | `wb_gain` + `white_balance` | ❌ 仅 lumen |
| 评级/旗标/标签 | `rating/flag` | `xmp:Rating`/`xmp:Label`(Green/Red) | `library.rate/flag/label` + catalog XMP 读写（`cli.py:196-200`） | ✅ 可互转（同一 `<stem>.xmp` sidecar 约定，host pick=Green/reject=Red） |
| 镜头/焦距/光圈元数据 | `aux:Lens/LensModel, exif:FocalLength, exif:FNumber` | `xmp.rs:128-163` | lumen 只读不写 | ➖ 仅 host |

**汇总**：宿主 6 字段中 5 个可映射（1 个 ⚠️ 色温、4 个 ✅/🟡），lumen 有 ~20 个域宿主完全没有；**没有任何一个宿主 tonal 字段是 lumen 缺失的**（除 lens 元数据写入）——集成方向单向收敛为 **host ⊂ lumen**，不存在 lumen 表达不了的宿主意图。

### 5.3 色温换算（唯一硬骨头）

- 宿主侧（`xmp.rs:175-177`）：`crs:Temperature` = **绝对 K**（读取端是 Lightroom/ACR）。
- lumen 侧：
  - `white_balance.kelvin` = 绝对 K（1500..25000，必须与 `camera_kelvin` 成对，`model.py:110-114`）；
  - `adjustments.temperature` = **相对相机 as-shot 的偏移**，正=暖，量纲不是 K。
- 集成规则（P1 起）：
  1. host → lumen：滑块值（-100..100 相对量）可 1:1 进 `adjustments.temperature`（但 UI 刻度需重新校准，因 lumen 映射到增益的系数是 `.4*temp`（`engine.py:521-523`）而非宿主 CSS 的 sepia 近似）；**从 XMP 回读的绝对 K 绝不能直接塞进该字段**（`validate` 会抛“工程中的数值超出支持范围”，`model.py:61-64`）——必须先用 `photo.open` 拿到的 `camera_kelvin` 换算成偏移量。
  2. lumen → host：反向拆成 `K_目标 = f(camera_kelvin, adjustments.temperature)`，写 XMP 时用绝对 K。
  3. 若不换算，退而求其次：**色温两侧各自独立存储**（宿主持 crs:*、lumen 持 recipe，互不同步）。P0 推荐此方案，避免错误写入。

---

## 6. 显影管线细节 + 宿主调色 UI 定位

### 6.1 `process()` 版本 1 vs 2（`engine.py:896-953`）

| 维度 | v1（1.0–1.5，旧工程默认） | v2（1.6.0 新照片默认，`model.py:28-30`） |
|---|---|---|
| 起点 | `clip01(source)` → `develop.apply` → 增益 | scene-referred **不裁剪**线性解码，负值/超 1 值保留（`engine.py:129-133`） |
| 顺序 | 曲线**先**于曝光/色调滑杆 | 曝光/白平衡/局部 shadow-highlight 在**未裁剪线性域**，develop 曲线当 tone map |
| 色彩 | sRGB 域 HSL/曲线/分级（`engine.py:643-657`） | **OkLCh** 单遍：饱和度/mixer/黑白/分级（`color.adjust`，`engine.py:645-651`） |
| 裁剪时点 | `_base` 里 `clip01` | 末端 `np.clip(x,0,1)`（`engine.py:953`） |
| 选择 | `process_version(edits)`（`engine.py:257-258`）→ 全部下游分支 | 同 |
| GPU | `gpu_pointwise`  fused 图（tonal/color/fused） | `gpu_version2`（tonal2/color2/fused2/…lab，`engine.py:476-513`） |

**对宿主的含义**
- recipe 必须**带着 `process` 版本一起读/写**（`edit.get` 返回、`edit.apply`/`set_process_version` 设置）。同一组 6 个宿主参数在 v1/v2 下观感不同（v1 先裁剪再调，v2 高光保留更多）。
- 缓存 key 的 canonical recipe 已含 `process`（`edit.get full` 返回），无需额外处理；但 §3.4 的“mtime key”隐含用 `.lumen` 工程里的版本，**工程没存 process 时 lumen 默认按 v1 渲染**（`model.py:78-79`）——宿主展示端应显示是哪个版本在渲染。
- 宿主不要把 `ToneAdjustments` 提升为“跨版本真理源”；P1 起宿主存 lumen recipe（或 `.lumen` 工程路径），`ToneAdjustments` 降级为视图。

### 6.2 相机参考曲线（`develop.py:16-54`）

从**相机内嵌 JPEG**（`raw.extract_thumb()`；Canon HDR PQ 走 `previews.hevc_preview`，PQ→SDR）取 800px，与线性解码 800px 各算 13 个亮度分位，拟合单调锚点曲线（`develop.py:37-49`）；失败退化“标准亮度”（`:50-54`）。**宿主侧无对应物，也不需要**：`photo.open` 后 recipe 的 `develop` 已含该曲线，宿主只读。

### 6.3 宿主调色 UI 的定位（明确结论）

| 阶段 | 宿主调色 UI | 渲染通路 | CSS filter（`PreviewViewport.tsx:187`） |
|---|---|---|---|
| **P0（只读）** | 保留现有面板（`TonalAdjuster.tsx`）+ `getToneFilterString`，仅作**无 lumen 渲染时的即时近似**；真正显示以 lumen 渲染为准（RAW 必走 lumen） | `lumen_preview_cmd` → `app_cache/lumen/` → `convertFileSrc` | ⚠️ **不得叠加**：一旦 `<img>` 指向 lumen 渲染结果，filter 必须置 `none`，否则二次显影（`autoTone.ts:149-192` 的 brightness/contrast 会作用在已显影的 JPEG 上） |
| **P1（直写）** | 6 个滑杆 → `edit.apply changes={adjustments:{...}}` → `render_preview`；色温按 §5.3 换算 | 同上，缓存 key 换成 recipe hash 模式（§3.4） | 删除/仅保留“拖动中”的过渡近似，松手即换成 lumen 渲染 |
| **P2（扩展）** | 曲线/HSL/分级/蒙版 UI（lumen 域） | 同 P1 | 删除 |

- `BeforeAfterViewport.tsx:119` 同步改造；`isHoldOriginal`（按住 `\` 看原片）在 P0 就有正确实现了：直接请求 `original=true` 的 lumen 渲染（显影原片）而不是关 filter。
- `image_statistics`（`nl_edit.py:458-487`）可替代宿主 canvas 直方图 auto-tone（`autoTone.ts:16-144`），尤其对 RAW 更准（在 1600px 显影图上统计，而非浏览器解码失败/内嵌 JPEG）。

---

## 7. EXIF / orientation（防双校正）

### 7.1 宿主侧（已实现）

- `read_orientation`（`thumbnail.rs:27-42`）：kamadak-exif 读 `Tag::Orientation`，默认 1。
- `apply_orientation`（`:45-56`）：orientation 2–8 → fliph/rotate180/flipv/rotate90/rotate270。
- 缓存 key 含 orientation（`:70-76`）。
- 对 RAW：exifreader 能从 RAW 容器里读到 EXIF（`try_extract_exif_thumbnail` 同理能读到 IFD1），所以 RAW 缩略图也已转正。

### 7.2 lumen 侧（分散在三处，需逐条确认）

| 位置 | 行为 | 代码 |
|---|---|---|
| RAW 解码 | `raw.postprocess(..., user_flip=None)`。rawpy 0.27.1 的 `user_flip` **默认使用 RAW 内置方向**（官方 Params 文档），⇒ **解码数组已转正**；且 `info` 的 width/height 对 flip 5/6 做了宽高互换（`engine.py:153`）= 转正后尺寸 | `engine.py:166-169,153` |
| 相机内嵌预览 | `libraw_preview`：**JPEG 自带 EXIF orientation 优先**（`ImageOps.exif_transpose`），否则按 `sizes.flip` 旋转（`previews.orient`：3→180°、5→90°、6→-90°） | `previews.py:30-49,172-174` |
| 8-bit 文件（JPEG/PNG/TIFF） | `load_pillow` 用 `ImageOps.exif_transpose` + ICC 转换 ⇒ 已转正 | `engine.py:301-319` |
| 16-bit TIFF/PNG | `cv2.imdecode` 路径，**注释明说 Pillow 只管 8-bit 的方向/ICC** ⇒ 该路径**不保证转正**（16-bit TIFF 由 lumen 做“按 sRGB 解读”的提示） | `engine.py:177-192` |
| 渲染输出 | `jpeg()` 用 `Image.fromarray` 编码，**不写 EXIF** ⇒ 输出 JPEG **无 orientation 标签** | `commands.py:517-521` |

### 7.3 双校正风险与对策

- **风险**：宿主 `oriented = apply_orientation(img, orientation)`（`thumbnail.rs:173,186`）若被误用到 lumen 输出上，会**二次旋转**（竖拍 RAW 直接倒置/躺倒）。
- **对策（三条，建议全做）**：
  1. **代码路径隔离**：lumen 预览走独立函数 `get_or_create_lumen_preview()`，**不调用** `read_orientation`/`apply_orientation`；缩略图快路径原样保留。文件名后缀 `_lumen` 便于 grep 审计。
  2. **webview 不重施**：lumen JPEG 无 EXIF orientation 标签，浏览器/`convertFileSrc` 不会自动旋转——这条天然安全，但要防“将来有人给 `jpeg()` 加 metadata”导致连锁。
  3. **验收用例**：取一张 orientation=6（竖拍旋转 90）的 RAW，断言 `render_preview` 输出宽高 = `photo.info` 的转正宽高，且与宿主 `read_orientation`+`apply_orientation` 处理后的 JPG 缩略图方向一致（像素级目视 + 宽高比断言即可）。
- 16-bit TIFF 输入是唯一已知不转正路径，P0 可接受（宿主的 16-bit TIFF 场景今天也解不了）。

---

## 8. Step-by-step 落地步骤（每步可独立验证）

> 前提（不属本领域）：sidecar 发现方式已由集成决策给定（`lumen-cli mcp` 常驻 + `lumen-cli run` 单发），lumen 钉 `43b4ebe` v1.6.0。以下步骤的“lumen_bridge.rs”指该 sidecar 封装模块（协议/进程管理细节归桥接领域，本领域只定义**渲染侧调用契约与缓存**）。
> 每步的“验证”都应在**未修改两个仓库**的前提下可执行：lumen 侧用源码树 `python main.py --cli …`（`cli.py:28-36` 的 `executable()`），宿主侧用现有 dev 运行。

### 步 1 · 契约冒烟：手测 MCP 渲染链路

**动作**：不起宿主，直接用 stdin 管道喂 `lumen-cli mcp --headless`：`initialize` → `open_photo`（一张测试 RAW）→ `render_preview`（带 `output` 参数写临时文件）。同时手测单发 `lumen-cli run render.preview '{"path":"...","size":1600,"output":"..."}' --headless`。
**验收**：
- 收到 `initialize` 的 result，`serverInfo.version == "1.6.0"`；
- `open_photo` 返回 `width/height/raw=true/note`（含 size 已按 flip 5/6 换算，§7.2）；
- `render_preview` 返回 `width/height/mime=image/jpeg/image(base64)`，且 `output` 路径下的文件存在、尺寸 = min(1600, size)、`file` 命令识别为 JPEG；
- stdout 只有 JSON-RPC 行（协议无污染），stderr 有 `lumen-cli.log` 之外无异常栈；
- 单发命令同一参数输出与 MCP 一致（差异只在 base64 有无）。

### 步 2 · `lumen_bridge.rs`：常驻 stdio 客户端（渲染子集）

**动作**：实现 `spawn(lumen-cli.exe, ["mcp", "--headless"])` + 逐行 JSON-RPC + 请求 id 自增 + 单例 `Mutex`（串行化调用，`mcp.py:102-118` 的 serve 是单线程 for 循环，并发请求会乱序）；stderr 重定向到日志文件（**不能** inherit 到 Tauri 控制台）。
**验收**：`cargo test` 里 initialize + render_preview 全通；`ping` 往返 <100ms；子进程崩溃后下一次调用自动 respawn（错误分类：`BrokenPipe`/`EOF` → 重启一次）；`Drop` 时关 stdin，子进程 5s 内退出无僵尸（Windows 上用 job object 或 wait）。

### 步 3 · `lumen_preview_cmd` + 缓存落盘（P0 核心）

**动作**：新增 `lumen_preview_cmd(file_path, width=1600, original=false)`：
1. 算 §3.4 的 key（含 `.lumen` 兄弟工程 mtime）→ 命中即返回路径；
2. 未命中 → `mkdir -p app_cache/lumen/` → 经 bridge 调 `render_preview(output=最终路径)`（**先写 `.tmp` 再 rename**）→ 返回；
3. `commands.rs` 注册 + `api.ts` 加 `getLumenPreview`（复用 `convertFileSrc`）。
**验收**：
- **1600px 预览生成耗时 < 1s**（20MP ARW，CPU 无 GPU 加速）；
- **缓存命中二次请求 < 50ms**（纯 `fs` 命中，不碰 bridge；可用 `Instant` 打点在 test 中断言）；
- 生成的 JPEG 落 `app_cache/lumen/`、文件名含 `_lumen_`；
- 工程文件（`.lumen`）mtime 变化后 key 变化（同一 RAW 改工程 → 渲染结果不同）；
- 与旧缩略图缓存**零串扰**：旧 `get_thumbnail_cmd` 全部既有用例不变。

### 步 4 · 大图预览接 lumen（P0 UI）

**动作**：`PreviewViewport.tsx` 对 RAW 源改用 `api.getLumenPreview(raw.path, 1600)`；**同时**把 `filter` 改为“lumen 渲染模式下强制 `none`”（`autoTone.ts` 增加开关或由 App 传空 tone）；`BeforeAfterViewport.tsx:119` 同步。
**验收**：
- RAW-Only 组大图正常显示（今天必裂，§2.1）；
- 竖拍 orientation=6 的 RAW 大图**方向正确且只转正一次**（§7.3 用例）；
- 有 recipe（`.lumen`）与无 recipe 的两张 RAW 显示不同（证明走的是 lumen 显影而非内嵌 JPEG）；
- 切图时 filter **不得二次叠加**：截图对比 `lumen 渲染` vs `lumen 渲染 + 原 CSS filter`，后者应被明确禁掉。

### 步 5 · 网格缩略图策略开关

**动作**：加设置项 `thumbnail_engine: "exif" | "lumen"`（默认 `exif`）。`exif` = 现状（快，相机显影）；`lumen` = RAW 走 `getLumenPreview(path, 200)`。`ThumbnailGrid.tsx:374-387` 按设置分流。
**验收**：
- `exif` 模式性能不回退（现有路径未动）；
- `lumen` 模式 200 张 RAW 文件夹**首轮**生成平均 < 400ms/张（含 20MB/张解码常驻，需按 §8 内存预算重启 sidecar）；
- 内存：sidecar RSS 在 32 张后触发重启策略，宿主 RSS 不随照片数线性增长（用任务管理器/`ps` 抽样记录到验收记录）。

### 步 6 · recipe 读回路（P1 前置）

**动作**：`lumen_recipe_cmd(path)` → `open_photo` + `get_edits full=true` → 存 `RecipeSnapshot { process, adjustments(16), develop, grading, effects, monochrome, lens 开关, has_curves, has_masks }`（raster/strokes 不落宿主）。
**验收**：
- 返回的键集 = `model.recipe()` 全集减 masks 内 raster/strokes（`commands.py:362-363`）；
- 两次调用同一照片返回一致（可 json diff）；
- `.lumen` 工程存在/不存在两种情况下 recipe 差异符合预期（工程优先，`session.py:66-90`）。

### 步 7 · recipe 写回路 + 实时渲染（P1）

**动作**：`lumen_apply_preview_cmd(path, changes)` → `apply_edits` → `render_preview`（key 切到 `recipe-{blake2b16(canonical)}` 模式，§3.4）；色温按 §5.3 换算。UI 侧 6 滑杆接此命令。
**验收**：
- `apply_edits changes={adjustments:{exposure:1}}` 后渲染平均亮度约为 2 倍（采样中心像素，允许 JPEG 量化 ±5%）；
- 同一 recipe 连续两次渲染**命中同一缓存文件**（证明 canonical hash 稳定，无 float 漂移）；
- `changes` 只写 lumen 会话内存，**原图与 XMP 不被改**（对比 `git status`/文件 mtime——在副本目录上验证）；
- XMP 写回（`update_xmp_tone`）与 lumen recipe 双轨并存，互不覆盖（§5.3-3）。

### 步 8 · 显影原片 / before-after

**动作**：`isHoldOriginal`（按住 `\`）改请求 `original=true` 的 lumen 渲染（§6.3），取代“关 CSS filter”的假原片。
**验收**：before/after 两张图除编辑外**像素尺寸一致、方向一致**；`original=true` 与 `edited` 走不同缓存文件（§3.4 variant）。

### 步 9 · 重活单发（全尺寸导出）

**动作**：宿主“全尺寸导出”按钮 → `lumen-cli render <photo> <out.jpg> --size <长边> --quality <q> --set ...`（`cli.py:89-115`），**不在常驻 MCP 会话里做**（大图会撑爆 20MB/张的会话内存）。
**验收**：一张 45MP RAW 全尺寸导出 < 15s（CPU）；导出文件 EXIF 无 orientation 标签且方向正确；`--overwrite` 未传时拒绝覆盖已存在文件（`commands.py:558-559`）；原文件 mtime/内容不变。

### 步 10 · 回归与验收记录

**动作**：把步 1–9 的断言固化成脚本（不进两仓库，放 `.plan/research/` 外的宿主测试目录），输出一张性能表（冷渲染/热缓存/方向/recipe 往返）。
**验收**：全绿 + 性能表达到上述阈值；文档更新到集成决策清单。

---

## 9. 风险与未决问题

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | `white_balance.metadata` 每次 `photo.open` 起 exiftool 子进程（`white_balance.py:26-48`，15s 超时） | 首张预览 +100–500ms；exiftool 缺失时只剩 warning、色温元数据没了 | 接受（一次性）；若 assets 未随附 lumen-cli，验收里要确认 warning 文案 |
| R2 | headless Session 常驻每张 1600px ≈20MB（`session.py:53`），**无淘汰** | 200 张网格 = 4GB，sidecar OOM | 步 5 的按量重启（建议 32 张或 700MB RSS）；网格默认走 `exif` 档 |
| R3 | `render.preview` 源上限 1600（`session.py:95` 的 `load_image(path)` 无 limit 参数） | `size=2048` 也只出 1600px | 文档化；确需 >1600 走 `lumen-cli render` 单发 |
| R4 | dispatcher 误连本机 lumen GUI（`mcp.py:73-80`） | 编辑被推到用户 GUI、产生 undo step、行为不确定 | 永远 `--headless`（`cli.py:158-159`）；bridge 启动参数写死 |
| R5 | 会话内 recipe 只在 sidecar 内存，宿主重启即丢 | P1 用户调色结果可能“消失” | P1 每 N 秒或失焦时 `save_project` 落 `.lumen`（这也让 §3.4 的 project_mtime 自然生效） |
| R6 | P2 开放蒙版编辑时 `edit.get full` 剔除 raster（`commands.py:363`）→ canonical hash 漏内容 | 缓存命中错图 | P2 起 hash 用 `.lumen` 工程文件内容而非 `edit.get` 返回 |
| R7 | 16-bit TIFF/PNG 输入不转正（`engine.py:177-192`） | 少数文件方向错 | P0 接受；需要时在 bridge 侧补一次 `apply_orientation`（仅 TIFF 分支） |
| R8 | 宿主 `scanner.rs:11-13` 的 RAW 扩展名比 lumen `engine.py:32` 少（`.rwl/.raw/.srf/.nrw/.crw`） | 这些 RAW 进不了宿主扫盘 | 扫盘阶段对齐（不属本领域，登记给扫盘/桥接） |
| R9 | 两个仓库只读约束 | 所有改动只能发生在宿主侧 `src-tauri/`、`src/`；lumen 侧只能“使用” | 本报告所有 lumen 行号基于 `43b4ebe` v1.6.0，升级 lumen 时重跑比对 |

---

## 附：本领域最短集成片段（契约速查）

```
# 常驻主循环（MCP）
open_photo{path}
get_edits{full:true}                         # P1 读
apply_edits{changes:{adjustments:{...}}}     # P1 写
render_preview{path,size:1600,original:false,output:"<app_cache>/lumen/<hash>_x_1600_lumen_edited.jpg"}

# 单发重活
lumen-cli render <in> <out.jpg> --size 4000 --quality 92 --set exposure=0.3 --overwrite
lumen-cli run photo.export_batch '{"folder":"...","paths":[...],"format":"jpg"}' --headless
```

（报告完）
