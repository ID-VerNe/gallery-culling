# ADR-012：宿主自绘边框水印（FR-12 最小版）

- 日期：2026-10-19
- 状态：已采纳（最小版；四边/多字段留待真实使用反馈）
- 相关：FR-12、报告 §21、`rendered-export-design-2026-10-17.md`

## 背景

FR-12 要求导出的成片带边框水印（LUMEN RAW 侧有：4 预设 + EXIF 字段）。
第一版计划是 **A1：改 LUMEN 上游**，真机勘察后确认走不通，四条证据：

1. **`lumen-raw/` 被主仓库 `.gitignore:37-39` 忽略**（注释写明是
   github.com/hety0211/lumen-raw 的克隆）。改上游**进不了 git** —— 无法评审、
   重新克隆即丢失。
2. **sidecar 是 PyInstaller 产物**：`_internal/lumen/` 里只有 `locales` 目录，
   Python 模块编译进 PYZ 归档，改二进制不现实。
3. **本机 `PyInstaller` / `cv2` / `numpy` 全部未安装** —— 重建得先装整套
   Python 构建工具链。
4. **`.gitignore:8` 引用的 `.plan/patches/build_lumen_sidecar.ps1` 目录不存在**
   —— 当初的补丁基建已丢失。

而且当前 sidecar 里的 LUMEN 水印**双重失效**（真机实验逐层剥开）：

- `assets/NotoSansSC.ttf` 被上游 `.gitignore:11` 忽略且本地没有 → 一开启水印
  直接 `lumen-cli: cannot open resource`；
- 临时把系统字体复制进 `_internal/assets/` 后能出图，但 ARW 的 EXIF 走
  ExifTool（`assets/exiftool/`，`.gitignore:12` 同样忽略）→ `photo.info`
  八个字段**全返回空串**，水印文案退化「未记录」。

同一组实验也证明了 LUMEN 水印机制本身没问题：手写 `.lumen` 工程 +
`photo.export`，802×1200、size=14 → 出图 802×1312（`pad = 112`），与
LUMEN `watermark.dimensions()` 逐字一致；`apply()` 在 `fit_long_edge()` **之后**
调用。问题只在两个被 gitignore 的资源缺失 —— 而「把二进制资源塞进 gitignore
的包」正是当初刻意避开的事。

## 决策

### 1. 宿主画：底边单条带，只对 JPEG

宿主侧流程：读回导出的 JPEG → 向下扩画布（`pad` 像素）→ 刷预设底色 →
用 `ab_glyph` 从系统字体画字 → 按导出质量重编码写回。

**只对 JPEG**：TIFF/DNG 要么是 16-bit 线性格式、要么走无损/封装，而本实现是
「读出来 → 扩画布 → 重编码」，对它们要么根本不支持（读不出 RGB8）、要么白白多压
一次。非 JPEG 拿到水印方案也安全忽略（`resolve_watermark` 与 `apply_watermark`
双重格式门禁，各有测试锁着）。

### 2. 尺寸公式与 LUMEN 逐字一致

```
pad = round(min(w, h) × size / 100)，至少 1
```

真机口径：802×1200、14% → 112 → 802×1312；1600×1067、14% → 149。
前端滑杆 8–35、缺省 14；后端 `validate_size` 拒绝 NaN/Inf 并夹取
（命令可被脚本直调，不走 UI）。

### 3. 四个预设（底色 / 墨色配对，暗底配亮字）

| 预设 | 底色 | 墨色 |
|---|---|---|
| gallery | 250,249,246 | 39,43,39 |
| noir | 20,23,23 | 231,234,225 |
| travel | 238,231,214 | 74,71,54 |
| sage | 220,228,214 | 41,62,43 |

前端写死这四个名，后端对**未知名整批拒绝**（「未知的水印配色「X」，可选：
gallery / noir / travel / sage」）—— 不静默回落：用户会以为水印生效了。

### 4. 文案三行，字段固定

```
机型 · 镜头            （如 ILCE-7M3 · FE 24-70mm F2.8 GM）
焦距 · 光圈 · 快门 · ISO 800
拍摄时间
```

任一字段缺失 → 那一行整体消失（不填空占位）；三行全空 → `apply_to_file`
返回 `Ok(false)`，**不加边框**（无 EXIF 的文件保持原样，而不是多一条空白带）。
EXIF 读法沿用 ADR-010 修订后全项目唯一顺序：`read_exif_preferring_jpg`
（配对 JPG 0.14 ms/张 vs RAW 11.1 ms/张，差 80 倍）。

### 5. 垂直居中 + 字号自适应，绝不裁字

```
margin  = round(pad × 0.15)
font_px = (pad − 2×margin) / rows × 0.76
top_gap = max(pad − block_height, 2×margin) / 2
```

顶对齐是**真机踩坑**：149px 带 + 3 行 90px 字，顶对齐给出 28/50 的上下留白，
肉眼「字贴在下边」；居中后 40/38。最宽一行放不下时字号逐次 −1px 直到放得下
（下限 6px）—— 与渲染器同策略：缩小可以，裁字不行。

### 6. 字体运行时读系统字体链，不打包

```
C:\Windows\Fonts\msyh.ttc   → simhei.ttf → simsun.ttc → segoeui.ttf（拉丁兜底）
```

`thread_local` 缓存一个 `FontVec`。**全缺失时 `require_font()` 让整批导出
提前失败**，而不是 200 张各自悄悄少个水印 —— 前者一次说清「找不到字体」，
后者的噪音难查得多。默认字段（机型/焦距/光圈/快门/ISO/时间）都是 ASCII，
拉丁兜底不会出方框；中文字体优先只是为了让将来的中文字段直接可用。

### 7. 质量沿用导出质量

水印要重编码一次 JPEG，这是宿主自绘的唯一画质代价。`jpeg_bytes` 用
`new_with_quality(quality)`，**不偷偷提质量** —— 用户选 85 就是 85。
`WatermarkPlan.quality` 由 `resolve_watermark` 从导出质量带入，测试锁死。

### 8. 接线点：渲染成功之后、`stage_rendered` 之前

水印在**临时文件**上原地处理（临时目录 + 原子搬迁的既有契约不受影响）：

```
render(tmp) 成功 → apply_watermark(tmp) → stage_rendered(水印结果)
```

- `resolve_watermark` 前置整批校验：未知预设 / NaN 尺寸 / 字体缺失 → 整个
  批次拒绝（一个文件都不碰）；
- 单张水印失败**不连坐**：记 `warning`，成片照样导出。为一条边框丢掉整张
  渲染结果才是真损失；
- 清单 `ExportManifestItem` 新增两个可省字段：`watermark: Option<bool>`
  （`None` = 本批没要求；`Some(false)` = 要求了但没加上）与
  `warning: Option<String>`（没加上的原因）。**刻意不复用 `error`** ——
  那个意味着「这项导出失败」，而水印只是装饰；
- 批次级 `RenderManifest.watermark` 留档 preset/size，日后要能回答
  「这批边框是什么配色、多宽」。

### 9. 前端：导出弹窗折叠区，仅 JPEG 输出时出现

`WatermarkOptions` 组件（`details`/`summary` 折叠，**默认关** —— 水印是可选项，
不该占每次导出的注意力；勾选后才出现配色与高度）。`formatUsesWatermark(jpg)`
门禁：切到 TIFF/DNG 整区消失，**表单状态保留**，切回来还是用户调好的样子。

`api.batchRenderExport` 收第九个参数；**没勾或 `enabled:false` 都整个省掉
`watermark` 键** —— 后端 `Option` 缺省 `None`，清单里也不会出现水印字段。
「键不存在」与「传了但关着」在后端是两条路径，api 层测试逐条锁死。

### 10. 撤消/重做不管水印

水印在导出时一次成型，不进 cull 命令栈（ADR-004）—— 导出本来就不是 undo
对象，重来一次导出即可。

## 测试

新增 42 例（后端 21 + 前端 21）：

| 层 | 文件 | 数量 | 覆盖要点 |
|---|---|---|---|
| 纯函数 | `watermark.rs` | 14 | 预设解析只认四个名、暗预设配亮字、尺寸 clamp 与非有限值拒绝、短边取尺寸（802×1200@14%→112）、字号随带宽缩放、**垂直居中**、留白不低于 2×margin、三行文案、缺项整行消失、无 EXIF 无边框、**质量透传到编码器**（q50<q92<q100 体积递增）、`apply_to_file` 加实测边框（尺寸 + 底色 + **带内有墨** + 上下留白差 ≤6px）、无 EXIF 不动文件、文件不存在报错 |
| EXIF 夹具 | `watermark.rs::testdata` | — | 手工构造 JPEG-APP1（IFD0 只放 0x8769 指针、标签进 Exif 子 IFD、RATIONAL 走后置数据） |
| 导出接线 | `commands/export.rs` | 8 | 无请求无方案、非 JPEG 无方案不报错、未知预设整批前拒绝、尺寸夹取且携带导出质量、warning 记录且照样导出、**非 JPEG 带方案也不画**（第二道格式门禁）、真 JPEG 加实测边框（160px 底边 + noir 底色入画）、未要求时两个键整个省掉 |
| EXIF 读法 | `scanner/metadata.rs` + `scanner.rs` | — | `read_exif_preferring_jpg` 配对 JPG 优先、主路径兜底 |
| 组件 | `export/exportComponents.test.tsx` | 6 | 默认折叠、未勾不摆控件、四预设与后端同名、滑杆 8–35 回传数字、只翻译 props、disabled 传导 |
| 表单 | `useExportForm.test.ts` | 3 | 默认关闭、三 setter 自增 resetSignal、勾选不改变可执行性 |
| 弹窗 | `BatchExportModal.modes.test.tsx` | 4 | 默认不传 watermark 键、勾选带完整对象、仅 JPEG 出现且切回保留、运行中禁用 |
| api 契约 | `api.test.ts` | 6 | 长边 0→null、非 0 原样、null/enabled:false 都不传键、enabled:true 带对象、返回 outcome |

**变异验证 11 处 11 抓**（变异一律替换断言瞄准的子串，不加无效前缀）：

- 前端 7：api 去掉 `enabled` 检查 → `传了 enabled:false 同样不出现` 红；
  组件去掉勾选条件 → `未勾选时不出现配色与高度控件` 红；默认值改 `true`
  → `默认关闭` 红；容器恒传对象 → 弹窗集成红；`formatUsesWatermark` 恒真
  → `水印区只在 JPEG 输出时出现` 红；滑杆下限 8→15 → 区间用例红；字号回传
  字符串 → `回传数字` 红。
- 后端 4：`apply_watermark` 去掉格式过滤 → `render_skips_watermark_for_
  other_formats_even_with_a_plan` 红；未知预设改静默跳过 →
  `unknown_preset_is_rejected_before_any_file_is_touched` 红；清单恒记
  `applied: true` → `render_records_the_watermark_warning_and_still_exports` 红；
  方案质量写死 100 → `watermark_size_is_clamped_and_carries_the_export_quality` 红。

**未覆盖的诚实记录**：`require_font()` 的「全字体缺失」分支无法在测试环境
构造（本机 msyh.ttc 常在）。它的价值由调用点位置保证（整批开工前、配置校验
之后），真机缺失时的行为只能靠人工验证。

回归：Rust `339 passed / 0 failed / 7 ignored`；clippy 0 告警；`cargo fmt`
对新代码 0 差异（基线既有差异未动）；`tsc --noEmit` 0 错；前端
`81 files / 812 passed`。

## 代价与风险

1. **只对 JPEG**。TIFF/DNG 用户要水印得另做（16-bit 贴字，或先出 JPEG 再封）。
   最小版刻意不碰 —— 没有真实需求前先不做。
2. **多一次 JPEG 解码 + 编码**。release 构建实测（6000×4000 ≈ 24MP，
   `apply_to_file` 全程 **616ms**，其中解码 57ms、编码与画布约 560ms）；
   debug 构建同一路径 10.9s —— `image` crate 的内置基线编码器对优化级别
   极敏感，任何性能结论必须用 release 口径。相对 LUMEN 的 6–8s RAW 导出
   （ADR-009），水印是叠加成本、不是占比成本：单张约 +10%，大批量导出时
   用户会直接看到总时长变长。缓解只有「默认关」。
3. **最小版只有底边 + 三行固定字段 + 4 预设**。LUMEN 有四边与更多字段，
   要不要追，等真实使用反馈再定 —— 现在追等于替想象中的需求写代码。
4. **字体依赖系统**。msyh.ttc 自 Win7 起必带，但极端精简系统可能只剩
   segoeui（拉丁兜底）。默认字段全 ASCII 所以不出方框；将来加中文字段时
   这条兜底会变成真实风险。
5. **与 LUMEN 水印版式不同步**。若将来 sidecar 修好（字体/exiftool 进包），
   两边版式、字段、质量策略都不一样。当前只有宿主一条路；真到那天应按设置
   二选一，而不是叠加。
6. **`image` crate 的编码器不是最快的一档**。换 `jpeg-encoder` 等更快实现
   能压缩第 2 条的时间，但那是引入新依赖换性能，留作有实测抱怨后的优化项。
7. **清单不进前端结果条**。`ExportOutcome` 不带水印计数，「N 张没加上」只在
   清单文件里。结果条已经告诉用户清单在哪；要把数字搬到结果条得改命令返回
   契约，优先级低于当前范围。

## 后续

1. 真实使用后决定要不要四边 / 更多字段 / 中文字段。
2. 若水印成为大批量导出的时长瓶颈，先换更快的 JPEG 编码器，再考虑并发
   （当前导出本身是串行的，水印也串行缀在尾部）。
