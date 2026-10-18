# LUMEN RAW × Gallery Culling 对照分析、风险评估与需求报告

| 项 | 值 |
|---|---|
| 对照对象 | LUMEN RAW 1.6.0（Windows，源码 `lumen-raw/`，Python 3.12 + PySide6） |
| 本项目 | Gallery Culling v2.0.3（Tauri 2 + React 19 + Rust） |
| 编制日期 | 2026-10-18 |
| 证据口径 | 源码逐文件核对；行号以当前工作区为准，可直接跳读验证 |
| 一句话结论 | 两者是同一流水线的上下游，不是竞品。该学的是**图库语义**与**任务纪律**，不该学**显影管线**。 |

> 读法：只看一页看 §0；只关心风险看 §7.2；只关心排期看 §8.5。

---

## 0. 摘要

### 0.1 五条结论

1. **定位互补，不是替代。** LUMEN 是「打开一张照片、把它调好、导出」的显影编辑器，图集是附属；本项目是「扫一个目录、把几千张过一遍、交付」的选片器，渲染外包给 LUMEN。两者已经在 `.lumen` 工程 + XMP + `lumen-cli` 处形成正确的集成缝（`src-tauri/src/lumen.rs:56` 钉 1.6.0，`lumen/mcp.rs` 走 legacy 握手，`runtime.rs:486` 调 `photo.export`）。
2. **最大差距不在图像处理，在图库语义。** 色标、查询式筛选、选片集、Lightroom 目录迁移、多步撤销——这五项是选片器的「操作系统」，恰好是本项目最薄的地方；而 LUMEN 的图像管线（LibRaw/ONNX/DirectML）对本项目既不可移植，也不该移植。注意：多步撤销 LUMEN 自己也没做（评级直接写 catalog，不进撤销栈），这一项是要**超过**它，不是对齐它。**（2026-10-18 进度：色标、查询式筛选、多步撤销、套用调色到选中、任务互斥五项已落地，见 ADR-003 / 004 / 005 / 006 / 007；剩余选片集与 `.lrcat` 导入在 S5。）**
3. **最大隐患是已经存在的数据破坏，不是未来风险。** 本项目把 `xmp:Label` 当作旗标用：`pick` 写 `Label=Green`，非 pick 清空 Label（`src-tauri/src/xmp.rs:443-448`），读回时把 Green/Red 当 pick/reject（`xmp.rs:515-524`）。这意味着用户在 Lightroom 里设的绿/红色标，会被本应用误读为留用/淘汰；而按 `P`/`U`/`0` 会**覆盖或清空** Lightroom 的色标。引入色标之前必须先解耦，否则是在坏数据上加功能。**（已于 2026-10-18 修复：ADR-001 解耦 + ADR-003 归还 `xmp:Label`；保留原文作为风险判断的存档。）**
4. **最值得学的三个机制**：追加日志 + 写盘合并（`catalog.py:181-209`）、字段查询语法（`catalog.py:269-336`）、显式工作状态机（`scheduler.py:41-53`）。三者都是纯逻辑，移植成本低、收益直接。
5. **明确不做**：自建 RAW 解码/显影、镜头校正、HDR/景深/全景合成、400MP 内存映射、全量 i18n。这些是 LUMEN 的主场，重复投入会把「极速选片」做成「半成品编辑器」。

### 0.2 建议的五个动作（按顺序）

| # | 动作 | 工期 | 理由 |
|---|---|---|---|
| 1 | 修 `xmp:Label` 语义冲突：读兼容旧值，写不再碰 Label | 2 天 | 阻止继续破坏 Lightroom 色标；一切色标功能的前提 |
| 2 | 色标（5 色）+ 快捷键 6-9 + 筛选/角标 | 4 天 | 选片从「两轴」变「三轴」，成本最低、收益最广 |
| 3 | 多步撤销（≥20 步，批量算一步） | 5 天 | 快速连按 `1..5/P/X` 的误触是选片第一痛点 |
| 4 | RAW-only 100% 细节查看 | 8 天（含 2 天 spike） | 对焦检查是选片的核心动作，当前 RAW-only 只有 1600px 预览 |
| 5 | 查询式筛选（先 chips 后语法） | 5 天 | 把固定 6 档升级为可组合条件，且能复用到导出范围 |

合计约 24 人日（另加写盘合并 2 天，共 26 人日 ≈ 5.5 周，单人）。这五项做完，本项目将补齐 LUMEN 图库语义中最常用的部分（色标/查询/撤销/100% 检查），选片集与 Lightroom 迁移留给 S5，同时保留自己在配对、对比、导出事务性上的优势。

---

## 1. 事实基线

| 维度 | LUMEN RAW 1.6.0 | Gallery Culling 2.0.3 |
|---|---|---|
| 产品定位 | 单张 RAW 显影编辑器 + 图库 | 多张选片/交付工具 + 渲染外包 |
| 技术栈 | Python 3.12 / PySide6 / NumPy / OpenCV / rawpy / ONNX Runtime | Rust / Tauri 2 / React 19 / TypeScript / SQLite |
| 代码规模 | `lumen/` 17,492 行；含 tools/tests 共 23,950 行 | Rust 9,727 行；前端 13,954 行（非测试） |
| 测试 | 254 个测试函数（README 记 356 项通过 / 11 跳过） | 144 个 Rust `#[test]`；453 个前端用例（56 个测试文件） |
| 自动化接口 | 27 条命令 × GUI / CLI / 命名管道 / MCP | 0 条自有命令；仅作为 LUMEN MCP 客户端 |
| 元数据轴 | rating / flag / label 三轴独立 | rating / flag 两轴；label 被旗标占用 |
| 持久化 | `catalog.jsonl`（追加日志）+ `.lumen` / `.lumenalbum` | SQLite（settings / sessions / rating_sync）+ XMP |
| 分发 | 安装版 / 便携版 / DMG；9 种界面语言 | NSIS + `updater.json` 自动更新；中文 |
| 平台 | Windows + Apple 芯片 macOS | 仅 Windows（WebView2） |

规模不是能力。LUMEN 的 17k 行里，大头是显影、AI、合成、Qt 界面；本项目真正要对齐的「图库 + 任务」部分，LUMEN 只用了约 1,500 行（`catalog.py` 487 + `scheduler.py` 241 + `rating.py` 的筛选部分 + `library.py` 的组织部分）。这也是为什么本报告的借鉴清单集中在少数几个文件。

---

## 2. 定位差异：编辑器 vs 选片器

### 2.1 工作流位置

```
拍摄 → 导入/配对 → 选片（Gallery） → 显影（LUMEN） → 交付
                    │                  │
                    ├── XMP 评级/色标 ──┤
                    └── .lumen 工程 ────┘
```

- **Gallery 在流水线前端**：它的产物是「哪些照片值得进入下一步」以及「每张照片的评级/旗标/色标」。它不需要把照片变好看，只需要让人**快速、准确、可逆地做决定**。
- **LUMEN 在流水线后端**：它的产物是「一张好看的成片」。图集、评级、筛选都是为「找到要修的那张」服务的附属功能。

### 2.2 交集与边界

交集只有三块：**图库元数据、筛选/组织、导出**。图像解码、显影、AI、合成是 LUMEN 的主场，本项目的正确策略是继续外包，而不是自建。

一个反直觉的判断：**本项目在「导出事务性」上已经领先 LUMEN**。LUMEN 的 `batch_export` 是「一张一张导出」，没有全有或全无的暂存语义；本项目是「先全部拷进临时目录，全部成功才改名进目标目录，取消则零污染」，并落 `.gallery-export.json` 清单（`src-tauri/src/commands/export.rs:1-14`）。这是选片交付场景更需要的语义，不能因为学 LUMEN 而退回去。

### 2.3 已存在的集成缝（做得对，别动）

| 机制 | 证据 | 评价 |
|---|---|---|
| 版本钉死 | `lumen.rs:56` `PINNED_LUMEN_VERSION = "1.6.0"` | 稳，但会变成维护债（见 R4） |
| 协议 | `lumen/mcp.rs:68-103` legacy `2024-11-05` 握手，严格校验 `serverInfo.version` | 正确：不赌新协议 |
| 能力探测 | `lumen/capabilities.rs:31-40` 用磁盘上的 4 个 ONNX 文件判 AI，不靠命令表 | 正确：实测 GPU/CPU 命令表逐字节相同 |
| 预览缓存 | `lumen/cache.rs:52-101` 键含路径/mtime/recipe hash/版本/宽度 | 正确：改调色必重渲，不改必命中 |
| 渲染导出 | `runtime.rs:463-498` 构造 `photo.export`，不常驻 session | 正确：`path` 自动 open，不要求先入库 |
| 评级回写 | `xmprw.rs:27-54` 先写 XMP，再推 LUMEN，失败只记账不回滚 | 正确：XMP 是互操作底线 |

结论：**集成缝的设计是对的，问题不在缝上，而在缝两侧各自缺什么。**

### 2.4 判断

本项目不应该变成「LUMEN 的轻量版」。它应该变成「选片这件事上无可替代的那一个」：配对、对比、100% 检查、三轴标记、可逆操作、事务性交付。LUMEN 的图库语义是这条路上的参照物，不是替代品。

---

## 3. 能力矩阵

图例：✅ 完整；◐ 部分；✗ 缺失；★ 本项目领先。

| # | 能力 | LUMEN RAW | Gallery Culling | 判断 |
|---|---|---|---|---|
| 1 | 多品牌 RAW 解码 | ✅ LibRaw + 特殊机型补矩阵 + CR3 HDR PQ | ◐ 只读 EXIF/内嵌缩略图，解码靠 LUMEN | 不追 |
| 2 | JPG/RAW 同名配对 | ✗ 无配对概念 | ★ 同名配对 + Complete/JpgOnly/RawOnly 状态机 | 领先 |
| 3 | 缩略图 | ◐ 图集缩略图，相机预览优先 | ★ 内嵌预览优先 + SIMD 回退 + 磁盘缓存 + 虚拟化 | 领先 |
| 4 | 大规模宫格 | ◐ 底部胶片条 | ★ 3/4 列虚拟化，万张 60fps | 领先 |
| 5 | 双图并排对比 | ✗ 只有前后对比 | ★ 并排 + 像素级联动平移 + 基准锁定/互换 | 领先 |
| 6 | 100% 细节检查 | ✅ 分块渲染，61MP 约 40ms | ✗ RAW-only 硬顶 1600（实测 `size=2048` 无效）；JPG 全分辨率 | **明显落后** |
| 7 | 星级 / 旗标 | ✅ 0-5 / P X U | ✅ 0-5 / P X U | 对等 |
| 8 | 色标 | ✅ 5 色（red/yellow/green/blue/purple） | ✅ 5 色 + 6/7/8/9、`Shift+6`、重复取消、角标、筛选五档（2026-10-18 补齐） | 对等 |
| 9 | 评级撤销 | ✗ 评级/旗标直接写 catalog，不进撤销栈 | ✅ 命令栈多步撤销（深度 50，批量算一步，ADR-004） | 领先 |
| 10 | 批量评级 | ✅ 多选 + 快捷键 | ✅ 多选 + 确认 + 进度 + 失败角标 | 领先（事务性） |
| 11 | 固定筛选 | ✅ 快速筛选 | ✅ 6 档 + 每档计数 | 对等 |
| 12 | 查询式筛选 | ✅ 字段语法 + 取反 + 通配 | ✅ 字段语法 + 取反 + 通配 + 6 个 EXIF 字段（ADR-005） | 对等（EXIF 字段为差异化） |
| 13 | 组织 | ✅ 图集 + `.lumenalbum` | ◐ 仅目录会话 | 落后 |
| 14 | Lightroom 迁移 | ✅ `.lrcat` 只读导入 | ✗ | 落后 |
| 15 | XMP 互操作 | ✅ ExifTool 批量读写 | ✅ 原生读写；`Label` 单值去重（ADR-003），LR 色标不再被覆盖 | 对等 |
| 16 | 调色 | ✅ 曲线/HSL/分级/蒙版/修复/预设 | ◐ 6 参数 + 委托 LUMEN | 不追 |
| 17 | 套用调色到多张 | ✅ `edit.copy` | ✅ 只复制 6 个 tone 字段、逐项失败报告、可取消（ADR-006） | 对等 |
| 18 | AI 蒙版 | ✅ 天空/人物/主体/背景/近景 | ◐ 通过 LUMEN 调天空等 | 对等（借力） |
| 19 | AI 降噪/超分 | ✅ Real-ESRGAN / DRUNet / NAFNet | ✗ 能力字段存在，但 sidecar 无命令 | 落后（且被上游堵住） |
| 20 | 导出 | ✅ jpg/png/tif/dng，≤400MP | ✅ 复制 + 渲染，原子提交 + 清单 + 取消 | 领先（事务性） |
| 21 | 边框水印 | ✅ 4 预设 + EXIF 字段 | ✗ | 落后 |
| 22 | 自动化 | ✅ 27 命令 × GUI/CLI/管道/MCP | ✗ 仅作为 MCP 客户端 | 落后 |
| 23 | 任务调度 | ✅ 状态机 + 单所有者队列 | ◐ 独立 flag + 进度/取消 | 落后 |
| 24 | i18n | ✅ 9 语言 | ✗ 中文 | 落后 |
| 25 | 自动更新 | ◐ 手动下载安装包（README 未提自动更新） | ★ `updater.json` + 签名更新 | 领先 |
| 26 | 测试密度 | 254 函数 / 356 用例 | 144 Rust + 453 前端用例 | 对等 |

**读法**：落后项里，1/16/18/19 属于「显影域」，继续外包；6/8/9/12/13/14/17/20/23 属于「选片域」，是本报告的重点；22/24 属于「平台化」，按需再谈。

---

## 4. 架构对比

### 4.1 进程与线程模型

| 维度 | LUMEN | Gallery |
|---|---|---|
| 主进程 | 单 Python 进程 + Qt 事件循环 | Tauri 主进程 + WebView2 |
| 重计算 | `QThreadPool` + `JobScheduler` 单所有者；AI 在独立进程 | Tauri `spawn_blocking` / 异步命令；渲染在 `lumen-cli` 子进程 |
| 崩溃隔离 | AI 子进程崩溃不拖垮编辑器 | sidecar 崩溃不拖垮宿主（已有重启/退避） |
| 取消 | `InterruptedError` + 队列丢弃 | `AtomicBool` + 哨兵错误 `TASK_CANCELLED` |

评价：本项目的崩溃隔离已经做得比 LUMEN 更彻底（sidecar 是外部进程），但**任务互斥**不如 LUMEN 明确。LUMEN 用一张 `BLOCKED_BY` 表回答「现在能不能开始」，本项目靠每个入口自己判断，容易出现「扫描中导出」「导出中重扫」这类竞态。

### 4.2 图像管线（为什么不能照搬）

LUMEN 的管线是：LibRaw 解码 → NumPy 浮点 → 线性光调色 → 局部色调映射 → OkLCh 调色 → GPU（DirectML/Metal）或 CPU → 分块渲染/编码。它为此写了 1,300 行 `engine.py`、620 行 `metal.py`、417 行 `gpu_graphs.py`，并随包 9 个 ONNX 模型。

本项目没有这条管线，也不该有：
- 技术栈不兼容：Python/NumPy/ONNX → Rust 需要重写全部算子；
- 定位不需要：选片器不负责「把照片调好看」，只负责「判断哪张值得调」；
- 维护成本不可承受：LUMEN 1.6.0 的主要工作之一就是处理版本 2，本项目没有这个人力预算。

**唯一值得借鉴的是「按需分块」的思想**：LUMEN 的 100% 视图只渲染屏幕可见的分块（`viewport.py` / `large_image.py`），而不是整张图。本项目的 100% 细节可以用「按需导出单张全尺寸」近似，不需要实现分块引擎。

### 4.3 元数据与持久化（关键差异）

| 维度 | LUMEN | Gallery | 影响 |
|---|---|---|---|
| 评级/旗标/色标 | 三轴独立，`catalog.jsonl` 为本地真值，XMP 可选 | 两轴，XMP 为唯一真值 | 本项目可移植性更好，但缺色标与本地日志 |
| XMP 写入 | ExifTool，可选、可批量、异步 | 原生 Rust，每次评级都写 | 本项目无外部依赖，但写入频繁 |
| pick 的表示 | 只存本地，不写 XMP | 写 `Label=Green` | **语义冲突（见 5.1）** |
| reject 的表示 | `Rating=-1` | `Rating=-1` | 一致，正确 |
| 组织 | `.lumenalbum`（JSON，相对路径，≤2000 张） | 无 | 缺选片集 |
| 崩溃安全 | 追加日志 + `fsync`，崩溃不丢评级 | XMP 原子写，但乐观 UI 失败后无持久记录 | 有丢失窗口 |

这一段是整份报告的核心。LUMEN 的 `catalog.py` 用 487 行解决了一个本项目还没意识到的问题：**「界面已经变了、磁盘还没变」这段时间里，数据归谁管**。本项目的答案是「归 XMP」，但 XMP 写失败时，界面上的新值没有任何持久记录，关掉应用就丢了。失败角标只能提醒，不能恢复。

### 4.4 并发与任务模型

LUMEN 的 `WorkState`（`scheduler.py:56-118`）把 7 种活动（加载/导出/AI/选区/预览/细节/缩略图）收进一个集合，用 `BLOCKED_BY` 表决定谁能和谁并行；`JobScheduler`（`scheduler.py:149-197`）保证同一时刻只有一个图像任务占用线程预算，按优先级出队，关闭时丢弃排队任务、等待活动任务排空。

本项目目前是「每个任务一个 flag + 一个取消命令」：扫描（`useFolderScan`）、导出（`useExportRun`）、渲染（`useLumenPreview`）、AI 蒙版（`useLumenOrchestration`）各自判断。好处是简单，坏处是组合爆炸——4 个任务就有 16 种组合，而实际需要禁止的只有少数几种。用一张表代替散落的判断，是低成本、高确定性的改进。

### 4.5 自动化接口

LUMEN 的 27 条命令是「一个入口，四个消费者」：GUI、`lumen-cli`、命名管道、MCP。每条命令有稳定 id、JSON Schema 参数、`read_only` 标记、可选的 MCP 工具名（`commands.py:34-56`）。参数校验统一做未知字段拒绝、枚举、最小/最大值、有限数检查（`commands.py:87-122`）。

本项目没有自有命令层，只有「作为客户端调 LUMEN」。这在当前阶段是合理的：选片器的用户是人，不是 agent。但如果未来要做「AI 帮我粗筛」或「脚本批量交付」，命令层是必要的基础设施。建议**先不建**，等 §8 的 P2 再看。

### 4.6 测试与质量

| 维度 | LUMEN | Gallery |
|---|---|---|
| 单元测试 | pytest 254 函数，覆盖引擎/合并/UI/版本迁移 | 144 Rust + 453 前端用例 |
| 集成/端到端 | `--smoke-test` / `--workflow-test` / `--merge-test` | `e2e:render` / `e2e:preset` 应用内驱动 |
| 变异验证 | 未见系统化 | AGENTS.md 明确要求「变异必须替换断言瞄准的子串」 |
| 回归护栏 | 处理版本 1/2 并存，旧工程画面不变 | 模块注释密度高，契约字段有测试锁死 |

评价：本项目的测试方法论（先写测试 → 变异验证 → 再改实现）比 LUMEN 更严格；LUMEN 的优势是**回归样本多**（真实相机、真实镜头、真实 Lightroom 文件）。借鉴时应学它的「真实文件回归」，而不是它的测试组织方式。

### 4.7 分发与更新

LUMEN：PyInstaller + Inno Setup / DMG，随包 Python、ExifTool、9 个模型、lensfun 数据库，安装包大但开箱即用；无自动更新说明。
本项目：NSIS + `updater.json`，安装包小，但依赖用户机器上的 LUMEN（可选）。自动更新是明确优势，不要为了「像 LUMEN 一样自带一切」而把 sidecar 塞进安装包——那会把 12 分钟的构建变成 30 分钟，并引入 Python 运行时维护。

---

## 5. 值得借鉴的清单

每条给出：LUMEN 的做法（证据）→ 对本项目的价值 → 落地方式 → 成本/风险。

### 5.1 三轴元数据 + 色标（P0，先修 bug 再加功能）

> **✅ 已完成（2026-10-18）**：解耦见 `adr-001-flag-storage.md`（pick 落 `.gallerycull.json`，读兼容 `Label=Green/Red`），色标见 `adr-003-colour-labels.md`（`xmp:Label` 归还用户，写入层按 `rdf:Description` 位置去重，单值不变式有测试锁定）。下面保留当时的诊断原文与四步方案，作为决策依据存档。

**LUMEN 做法**
- `catalog.py:33-45`：`flag`（pick/reject）与 `label`（red/yellow/green/blue/purple）是两个独立字段。
- `catalog.py:424-429`：写 XMP 只写 `xmp:Rating` 与 `xmp:Label`；pick 不写 XMP，reject 写 `Rating=-1`。
- `catalog.py:58-64`：`label_from_text` 接受多种语言的色标名（英/简/繁/德/法/西/意/日/韩/俄），避免「Lightroom 写 Red、本应用读不懂」。
- `rating.py`：快捷键 0-5 星级、P/X/U 旗标、6-9 色标（紫色走菜单）。

**真实数据佐证（2026-10-18）**

用户相册 `Pictures\Camera Roll6年9月12日-惠州西湖` 的 156 个 sidecar 里，`DSC04477.xmp` 含 `<xmp:Label>Green</xmp:Label>` 与 `<xmp:Rating>5</xmp:Rating>`——**旧约定不是理论风险，用户盘上已经有真实文件**。这也验证了 ADR-001 的回落路径：无本地条目时 Green→pick 仍能读回（真实文件实测通过），写入 none 后能被压住，且 XMP 字节不变。

**本项目的现状与隐患**
- `xmp.rs:443-448`：`pick` → `Label=Green`；非 pick → `Label=""`。
- `xmp.rs:515-524`：`Label=Green` → pick，`Label=Red` → reject。
- 后果一：用户在 Lightroom 里把一张照片标成绿色（可能是「已交付」），本应用显示为「留用」。
- 后果二：用户按 `P`，本应用把原有的蓝色标覆盖成 Green；按 `U` 或 `0`，直接把色标清空。**这是已经发生的数据破坏，不是假设。**
- 后果三：非英文色标（`Grün`、`绿色`、`Rouge`）无法映射为旗标；当前界面又不显示色标，等于对用户完全不可见。

**落地方式**
1. **先解耦**：`write_xmp` 不再根据 `flag` 改 `meta.label`；`flag_from_xmp` 只认 `rejected`（Rating=-1），不再把 Green/Red 当旗标。
2. **读兼容（有歧义，必须显式）**：`Label=Green` 既可能是旧版本应用写的「留用」，也可能是用户在 Lightroom 里设的真实绿色标，**无法从文件本身区分**。默认策略：按 pick 兼容（旧文件不丢），设置里给「旧版 Green=留用 兼容」开关，默认开；关闭后 Green 只作为色标。升级时提示一次，让用户知道这个歧义的存在。
3. **pick 的持久化**：不写 XMP（避免再次占用 Label），存本地。可选两种：SQLite 新增 `flags` 表，或复用 `rating_sync` 增加 `pick` 字段。选片场景下 pick 不需要跨机迁移，本地足够；若要跨机，走选片集（5.9）。
4. **加色标**：`PhotoGroupInfo` 增加 `label: 'none'|'red'|'yellow'|'green'|'blue'|'purple'`；XMP 写英文名（Lightroom 约定），读时用 LUMEN 的多语言表。
5. **UI**：缩略图右下角 6px 色点；底栏筛选增加「色标」档；快捷键 6/7/8/9，重复按取消；紫色用 `Shift+6` 或菜单（LUMEN 也只给了 4 个键）。

**成本/风险**：6 天（解耦 2 + 色标 4，含迁移测试）。风险是旧文件语义变化，必须配「读兼容 + 迁移提示 + 回归用例」；不要静默改变用户已有标记的含义。

### 5.2 写盘合并 + pending 表（P0）

**LUMEN 做法**
- `catalog.py:181-193`：每次修改追加一行 JSON，`flush` + `fsync`，崩溃最多丢最后一行；写前若文件末尾不是换行，先补一个换行，避免半行污染下一条。
- `catalog.py:221-251`：`set` 先 `refresh` 读入其他进程的追加，再合并本批修改；相同值不写。
- `catalog.py:195-209`：日志行数超过照片数 4 倍且 ≥2000 行时，原子重写压缩。

**本项目的现状**
- 每次按 `1..5/P/X/0` 都发一条 IPC、写一次完整 XMP（`useRatingFlagSync.ts:92-230`）。快速连按时，同一文件会被反复读-改-写。
- 写失败时 UI 保留新值 + 角标，但**没有任何持久记录**；用户关掉应用，这次修改就消失了（`xmprw.rs:27-54` 只在 LUMEN 推送成功时写 `rating_sync`，Lumen 关闭时连游标都没有）。
- `rating_sync` 表的语义是「LUMEN 同步游标」，不是「待写 XMP 队列」，不能直接当 WAL 用。

**落地方式（借机制，不借文件格式）**
1. SQLite 新增 `pending_xmp(path PRIMARY KEY, rating, flag, label, updated_at)`。
2. 评级入口：先写 `pending_xmp`（同步、极快），再乐观更新 UI，然后异步入队写 XMP；成功则删行，失败保留。
3. 写盘线程：单线程 + 按 path 合并，同一照片 400-500ms 内的多次改动只落盘最后一次；退出前 flush。
4. 启动时：`SELECT * FROM pending_xmp`，逐条重写 XMP；若 XMP 的 mtime 晚于 `updated_at`，说明外部（Lightroom）改过，放弃本条并提示冲突（与 5.7 共用逻辑）。
5. 不需要 JSONL：本项目是单进程，SQLite 的 WAL 已经足够；LUMEN 用 JSONL 是为了多进程追加（CLI/MCP 同时写），本项目没有这个需求。

**成本/风险**：2 天。风险是「pending 表」成为第三份真值——必须明确：**XMP 仍是 canonical，pending 只记录尚未落盘的意图，成功即删**。任何读路径都不读 pending 作为最终值。

### 5.3 多步撤销（P0，本项目要超过 LUMEN 的一项）

> **✅ 已完成（2026-10-18，`adr-004-undo-stack.md`）**：命令栈 50 步、批量算一步、`Ctrl/Cmd+Z` 撤销 / `Ctrl/Cmd+Shift+Z`（或 `Ctrl+Y`）重做、底栏可读摘要；外部改动检测落在后端 `check_cull_state_cmd`（比内容而非 mtime），冲突时弹确认不盲目覆盖。共 25 条用例 + 13 处变异验证。

**LUMEN 做法（以及它没做的部分）**
- LUMEN 的**编辑**动作走命令层，窗口上下文把每次 `apply` 记成一个可撤销步骤（`commands.py:3-8`）；这是它撤销设计的可取之处。
- 但**评级/旗标/色标不进撤销栈**：`library.rate` 直接调 `catalog.set`（`commands.py:265-271`），写追加日志，没有 undo。也就是说，LUMEN 在「选片」这件事上并没有解决误触问题。
- 结论：这一项**不是照抄，而是借鉴命令模式、补上 LUMEN 缺的那一半**。本项目已经领先一步（单步撤销），要做的是把它扩展到多步。

**本项目的现状**
- 只有单步撤销（`useRatingUndo.ts`，`useRatingFlagSync.ts:240-265`），且只覆盖星级/旗标，不覆盖批量操作、调色、色标（未来）。
- 快速选片时，用户经常连按 `X` 淘汰三张后发现第一张是误判，单步撤销救不了。

**落地方式**
1. 定义 `CullCommand`：`{ kind: 'rate'|'flag'|'label'|'clear'|'batch', items: [{id, path, before, after}] }`。
2. 环形缓冲 50 条；批量操作（多选打分/旗标/清除）整体算一条命令。
3. `Ctrl/Cmd+Z` 撤销，`Ctrl/Cmd+Shift+Z` 重做；撤销执行的是「把 before 写回去」，复用同一套写盘队列（5.2），因此天然合并、天然有 pending 保护。
4. UI：底栏显示「撤销：淘汰 3 张」这类可读描述，而不是「撤销」两个字。
5. 调色是否纳入同一栈？建议**先不纳入**：调色的 before/after 是 6 个浮点数，纳入后栈的语义会变复杂；等评级/旗标稳定后再评估。

**成本/风险**：5 天。风险是「撤销」与「外部 XMP 变更」冲突：撤销前应检查 sidecar mtime，若外部改过，提示「磁盘已被其他程序修改，是否仍撤销」。不要盲目覆盖。

### 5.4 RAW-only 100% 细节查看（P0，战略必须）

**LUMEN 做法**
- 100% 视图只渲染屏幕可见的分块，61MP 照片放大调整时界面最长停顿约 40ms（README「大图查看」）。
- `large_image.py:7-9`：400MP 上限、>256MB 用内存映射、64 行一条带编码。

**本项目的现状**
- JPG 分组：直接用 JPG 资产 URL，全分辨率，100% 可用。
- RAW-only 分组：`useLumenPreview` 固定 `width=1600`（`useLumenPreview.ts:29`）。**实测更正（2026-10-18）**：`render.preview` 的 schema 上限虽是 2048（`commands.py:524-528`），但 `engine.load_image` 的默认 `preview_limit=1600`（`engine.py:126`）先一步把源缩到 1600，`resize_limit` 只缩不放（`engine.py:70-75`）——因此 **`size=2048` 实际仍返回 1069×1600，JPG 源也一样**。1600 是 LUMEN 预览管线的硬顶，不是本项目的保守选择。放大到 5×（上限 10×，且 scale 相对「适应窗口」，不是 1:1）只是把 1600px 的图拉大，**无法判断对焦**。
- 更糟的是，`PreviewViewport.tsx:120` 明确注释「scale=1 实为适应窗口，并非 1:1」，说明团队已经意识到这个口径问题，但还没有解决数据源。

**落地方式（不改 LUMEN）**
1. 新增 `lumen_detail_cmd(path, recipe_hash)`：调 `photo.export` 到缓存目录，`long_edge` 用原图长边（上限 20000），`quality=95`，格式 jpg。`photo.export` 支持 `long_edge`（`commands.py:543-547`）。
2. 缓存键复用现有 `lumen_cache_key_with_recipe`（`cache.rs:52-101`），加 `detail` 变体；命中直接返回。
3. 交互：缩放超过 2.5× 或按 `Z` 时触发；先显示 1600 预览，细节就绪后无缝替换；失败降级为预览 + 明确提示「细节渲染失败，已退回预览图」。
4. 缓存上限 2GB，LRU 淘汰；退出不强制清理（下次还能命中）。
5. 性能预期：见下方实测——**不是 1-3 秒，而是 6-8 秒/张（24MP）**，这条改变了交互设计。

**实测数据（2026-10-18，真实相册样片，非合成）**

素材：`Pictures\Camera Roll\2026年9月12日-惠州西湖`，Sony ARW 4024×6024（24.2MP），单文件约 25MB。工具：`src-tauri/binaries/lumen-cli/lumen-cli.exe`（1.6.0），三次取样。

| 操作 | 耗时 | 峰值内存 | 产物 |
|---|---|---|---|
| `photo.export` 全尺寸（24MP） | 6.3 / 6.7 / 8.3 s | 761 MB | 3.7–6.0 MB JPEG |
| `photo.export` `long_edge=2048` | 5.8 s | 761 MB | 0.56 MB |
| `render.preview` size=1600 | 1.1 s | 262 MB | 1069×1600 |
| `render.preview` size=2048 | 1.1 s | — | **1069×1600（没有变大）** |
| 同文件二次全尺寸导出 | 7.7 s | — | 无缓存效应（CLI 一次性进程） |

三条结论：

1. **解码是瓶颈，不是编码。** `long_edge=2048` 只省 0.5 秒、内存一模一样——降分辨率不解决问题，没有「便宜的中间档」。
2. **每张 761MB 峰值。** 并行预取 3 张就是 2.3GB，必须**串行**（并发上限 1）。
3. **按像素线性外推**：45MP 约 12–16 秒、1.4GB。所以原定「首次 ≤3s（45MP）」的验收标准不可能达到，必须改。

顺带实测（同一台机器、同一相册）：**整本 156 组（156 ARW + 156 JPG）只读扫描 78–85 ms**（0.5 ms/组），156 组全部正确配对、无错配。扫描不是瓶颈，性能预算可以整块留给渲染。

**修正后的交互设计**

- 触发时先显示 1600 预览 + 明确的「正在渲染细节…」进度（可取消），不阻塞翻图；
- 全尺寸 JPEG 落缓存（一张 4–6MB，比原方案估的更大），LRU 上限按 2GB 算约可存 350–500 张；
- 预取**只做当前张的 ±1**，串行队列，翻图快时跳过中间项（否则用户快速翻 20 张会积压 2 分钟）；
- 真 1:1 只在用户明确按 `Z`/双击时触发，不做「缩放超过 2.5× 自动触发」——6-8 秒的自动等待会毁掉浏览手感。

**成本/风险**：8 天（2 天 spike 验证导出耗时与画质，5 天实现，1 天测试）。风险：磁盘占用（按 5MB/张重估）、6-8 秒延迟、LUMEN 版本差异导致 `long_edge` 行为变化。兜底：JPG 分组永远可用；RAW-only 失败时明确告知，不静默降级。

### 5.5 查询式筛选（P1）

> **✅ 已完成（2026-10-18，`adr-005-query-filter.md`）**：`utils/queryMatch.ts` 移植了
> `parse_query` / `matches` 并扩展 iso / camera / lens / aperture / shutter / focal 六个
> EXIF 字段。裸词仍按文件名子串匹配（老搜索框的肌肉记忆不改写）；解析出错只提示、
> 不清空宫格；10k × 3 词条实测 ~18ms（NFR 要求 <50ms）；导出范围新增「当前筛选结果」档，
> 与宫格共用同一份谓词（语法有错时候选归零，不猜）。33 条纯逻辑用例 + 9 条 App 接线用例
> + 5 条导出用例，变异验证 8 处抓到、1 处等价存活。以下原文保留作存档。

**LUMEN 做法**
- `catalog.py:269-305`：`parse_query` 把 `rating>=3 -flag:reject label:red name:DSC0* ext:arw folder:2024 edited` 解析成词条；`-` 取反；`picked`/`rejected`/`unflagged`/`edited`/颜色名是简写；`★★★+` 也是语法。
- `catalog.py:313-336`：`matches` 对每个词条求值，全部满足才通过；name 支持 `fnmatch` 通配。

**本项目的现状**
- `FilterMode` 固定 9 档（`types/index.ts:21-24`），UI 暴露 6 档（`filterMatch.ts:56-63`）；搜索只匹配 `baseName` 子串（`useCollection.ts:50-56`）。
- 用户想找「ISO≥3200 且 85mm 且 未淘汰」只能肉眼翻。

**落地方式**
1. 把 `parse_query`/`matches` 移植成 TS 纯函数（`src/utils/queryMatch.ts`），语义逐条对齐 LUMEN 的测试；这是纯逻辑，没有平台依赖。
2. **扩展字段**：本项目有 EXIF（`PhotoGroupInfo.exif`），增加 `iso`、`camera`、`lens`、`aperture`、`shutter`、`focal` 六个字段——这是 LUMEN 没有的，属于本项目的差异化。
3. UI：保留现有 chips（全部/仅 Pick/已淘汰/未标记/★3+/★5），chips 之上加一个搜索框；输入语法时显示解析结果（「3 个条件」），错误时给示例，不弹红框。
4. 计数：现有 `countByFilter` 只服务固定档；查询模式下显示「匹配 N 张」，不要试图给每个 chip 都算一遍。
5. 导出复用：批量导出弹窗的「范围」直接接受查询结果，避免两套筛选逻辑（当前 `exportFilters.ts` 已有一份范围判定，必须合并，否则又是「两处漂移」）。

**成本/风险**：5 天。风险是语法门槛：摄影师不想学查询语言。缓解：chips 是主路径，语法是进阶；搜索框 placeholder 直接给可复制示例；首次使用展示 3 个例子。

### 5.6 套用调色到选中（P1）

**LUMEN 做法**
- `commands.py:472-478`：`edit.copy` 只复制「look」（tone、color、effects、process、lens 开关），**不复制** crop、mask、retouch；每张照片保留自己的构图与局部调整。
- 这与「把当前调色套用到选中照片」的菜单项是同一个语义。

**本项目的现状**
- 有调色面板（6 参数）和 `apply_tone_cmd`，但只能对当前照片；多选后没有「套用到选中」入口。
- 选片交付的典型动作：同一场景 200 张，先调好一张，再套给其余 199 张。现在只能一张张来。

**落地方式**
1. `TonalAdjuster` 增加「套用到选中 N 张」按钮（仅 `selectedIds.size > 1` 时显示）。
2. Rust 侧复用现有 `apply_tone_cmd` 的逐张逻辑，加一个批量命令：`batch_apply_tone_cmd(ids, tone)`；每张写 XMP + `.lumen`（如果引擎开启），逐项报告失败。
3. 只复制 6 个 tone 字段，不碰 rating/flag/label；如果未来有 monochrome，单独开关。
4. 进度条复用 `useTaskProgress`；取消语义复用导出的「取消 ≠ 失败」。

**成本/风险**：3 天。风险：批量写 `.lumen` 时 LUMEN 会话可能很慢（每张一次 `edit.apply` + `save_project`），200 张可能几分钟。缓解：先只写 XMP，`.lumen` 写入做成可选（「同时写入 LUMEN 工程」复选框，默认关）；或者用 LUMEN 的 `photo.export_batch` 一次性渲染，不在宿主逐张写工程。

**实现记录（2026-10-18，ADR-006）**：按上面的缓解方案落地 —— 前端逐张复用
`apply_tone_cmd`（不新增批量命令，避免第二套写入语义），`write_lumen` 默认 `false`，
复选框可开。目标 = 选中 ∩ 当前筛选 − 源（按 id 与归一化路径双重排除）。单张失败不中断，
error toast 持久列前 3 条；XMP 成功但引擎失败的警告按原因聚合成一句。成功的目标会清掉
`toneMap` 里的未保存编辑，否则旧值遮蔽新基线。**不纳入撤销栈**（tone 没有 before 快照，
`CullCommand` 三元组也不含 tone），已在面板与 ADR 中如实标注。测试 25 例（hook 14 +
组件 7 + App 接线 4），变异 5 处 4 抓 1 等价存活。

### 5.7 XMP 增量导入与冲突裁决（P1）

**LUMEN 做法**
- `commands.py:293-298`：`library.read_xmp` 从 sidecar 或内嵌 XMP 读入评级/色标，`merge(overwrite=True)`。
- `catalog.py:380-410`：ExifTool 批量读，200 个文件一批，用 `-@` 参数文件避免命令行长度限制。
- `catalog.py:445-487`：`.lrcat` 只读导入，Lightroom 占用时复制一份再读。

**本项目的现状**
- 扫描时读 XMP（`scanner.rs`），但运行期间不监听外部变化；用户在 Lightroom 改完回来，界面还是旧值，必须重扫。
- `rating_sync` 表有 `sidecar_mtime`，具备做增量的基础，但目前只用于 LUMEN 推送。

**落地方式**
1. 窗口重新获得焦点时（或手动「从 XMP 重新读取」），stat 所有 sidecar 的 mtime；与 `rating_sync.sidecar_mtime` 或扫描时记录的 mtime 比对，只读变化的。
2. 若本应用有未同步的 pending（5.2），且外部也改了 → 冲突：弹三选一「保留本地 / 采用外部 / 逐张选择」，**不自动覆盖**（与现有 LUMEN 冲突模型一致）。
3. 批量读用 Rust 线程池，200 个一批；不要在主线程 stat 10k 个文件。
4. 结果用 toast 汇总：「已从 XMP 更新 12 张，3 张有冲突待处理」。

**成本/风险**：3 天。风险是冲突语义复杂；建议第一版只做「外部优先 + 冲突列表」，不做逐字段合并。

### 5.8 工作状态机 + 单所有者队列（P1）

**LUMEN 做法**
- `scheduler.py:27-35`：7 种 Activity。
- `scheduler.py:39-49`：`EXCLUSIVE`（阻塞关闭）与 `BLOCKED_BY`（谁能和谁并行）两张表。
- `scheduler.py:149-197`：单活动任务、优先级队列、关闭时丢弃排队、等待活动任务排空。

**本项目的现状**
- 扫描/导出/渲染/AI 各自有 flag；没有一张表回答「现在能不能开始导出」。
- 已知风险：扫描完成回调会覆盖用户在扫描期间的选择（`App.tsx:152-180` 的注释记录了 2026-10-15 e2e 实锤）；同类竞态在导出/重扫组合里仍可能存在。

**落地方式**
1. Rust 侧 `WorkState { active: Mutex<HashSet<Activity>> }`，命令入口统一 `try_begin(activity) -> Result<Guard, Busy>`。
2. 表（建议）：
   - `SCAN` 阻塞 `EXPORT`、`RENDER`（列表未定，导出范围不可信）；
   - `EXPORT` 阻塞 `SCAN`、`RENDER`（避免读同一批文件）；
   - `RENDER` 阻塞 `EXPORT`（同一 LUMEN sidecar，串行更稳）；
   - `AI` 阻塞 `RENDER`、`EXPORT`；
   - `THUMBNAIL` 可与 `SCAN` 并行，但被 `EXPORT` 阻塞（磁盘争用）。
3. UI：禁用按钮 + **常驻原因**（footer 状态区），不要只放 `title`（AGENTS.md 已明确：disabled 按钮不可聚焦，title 读屏拿不到）。
4. 错误码 `E_BUSY` 带 `blockers` 列表，前端映射成「正在导出，暂不能重新扫描」。

**成本/风险**：3 天。风险是过度互斥导致「什么都不能点」；建议只禁止真正危险的组合，渲染与缩略图可以放宽。

**实现记录（2026-10-18，ADR-007）**：前端 `utils/taskMutex.ts` 定义 7 种活动与
`BLOCKED_BY` 表（对称 + 不自阻 + 只禁危险组合：六种长任务两两互斥，缩略图仅被
导出/渲染阻塞），`TaskMutexProvider` + `useActivity(activity, running)` 让各组件
自己声明运行态。禁用原因**画在屏幕上**（disabled 按钮不可聚焦，title 读屏拿不到）：
扫描按钮右侧、导出弹窗 footer 状态位、调色面板说明区。后端 `taskgate.rs` 用
`Mutex<HashSet<Activity>>` + RAII Guard 覆盖扫描/导出/渲染/AI，`try_begin` 永不阻塞，
`E_BUSY` 带中文原因；**抢占排在 `cancel.store(false)` 之前**，否则重入会抹掉正在跑的
任务的取消请求。测试 34 例（前端 25 + Rust 9）；变异前端 6/6 抓住，后端 3 处 2 抓
1 等价存活（`a == b` 条件冗余）。

### 5.9 选片集（P2）

**LUMEN 做法**
- `library.py:323-353`：`.lumenalbum` 是 JSON，`version=1`，每张照片记 `source`（相对路径，失败则绝对路径）、`edits`、`snapshots`、`initialized`、评级/旗标/色标；≤2000 张、≤128MB；临时文件 + `replace` 原子写。
- `library.py:355-380`：打开时校验 `application` 与数量，恢复评级与编辑。

**本项目的现状**
- 只有「目录会话」（SQLite `sessions` 表，记住上次目录与断点），没有跨目录的选片集。
- 婚礼/活动摄影师经常分多个卡/多个目录导入，最后要合成一个「精选集」交给修图师。

**落地方式**
1. `.galleryalbum` JSON：`{application:"Gallery Culling album", version:1, documents:[{source: relative, rating, flag, label, tone?}]}`。
2. 相对路径优先（相对 album 文件所在目录），跨盘时退回绝对路径并在打开时报告缺失。
3. 打开选片集时：不要求照片都在同一目录；按 `source` 逐个 stat，缺失的列出来，不阻塞其余。
4. 原子写：temp + rename；上限 2000 张 / 128MB（照抄 LUMEN 的边界，避免有人拿它当图库）。

**成本/风险**：6 天。风险是「选片集」与「目录会话」概念重叠，UI 上要区分清楚：会话是「上次看到哪」，选片集是「这批照片的清单」。

### 5.10 Lightroom 目录导入（P2）

**LUMEN 做法**
- `catalog.py:445-487`：只读打开 `.lrcat`；若被 Lightroom 占用，复制到临时目录再读；SQL 联表 `Adobe_images` / `AgLibraryFile` / `AgLibraryFolder` / `AgLibraryRootFolder`；跳过虚拟副本（`masterImage IS NULL`）；`pick=1/-1` 映射 pick/reject，`colorLabels` 映射色标。

**本项目的现状**
- `rusqlite` 已经是依赖（`db.rs`），技术上零新增。
- 目标用户大量来自 Lightroom，迁移时最痛的是「我在 LR 里已经标好了，不想重标」。

**落地方式**
1. 新增 `import_lrcat_cmd(path)`：只读打开，失败则复制；返回 `{path, rating, flag, label}` 列表。
2. 路径映射：LR 的 `absolutePath + pathFromRoot + baseName.extension` 与本项目的配对键（baseName）对齐；对不上的列出来，不猜。
3. 冲突：默认「只填空白」（`overwrite=false`），用户勾选「覆盖已有评级」才覆盖（与 LUMEN `merge` 的语义一致）。
4. 导入后写 XMP（可选），并提示「已导入 N 张，M 张找不到对应文件」。

**成本/风险**：6 天。风险是 LR 目录版本差异与路径大小写；测试要用真实 `.lrcat` 样本（可让用户提供，或构造最小 schema）。不要承诺「导入编辑」，只导入评级/旗标/色标。

### 5.11 边框水印（P2）

**LUMEN 做法**
- `watermark.py:9-14`：4 个预设（画廊白/暗夜黑/旅行纸/山野绿），字段 date/body/lens/aperture/shutter/iso/focal/brand；保留浮点图像，只在边距里画文字；支持 PNG 标志（≤2048px）。
- 在导出管线里应用（`batch_export.py:133`）。

**本项目的现状**
- 导出只有复制/渲染，没有水印；交付给客户的成片常常需要白边 + 拍摄参数。

**落地方式（优先借 LUMEN，不自己画）**
1. 方案 A（推荐）：把水印参数写进 `.lumen` recipe，由 LUMEN 渲染时应用。前提是确认 `photo.export` 会读取 recipe 的 `watermark` 字段（`batch_export.py` 会），宿主只需在导出前 `edit.apply` 写入 watermark 配置。
2. 方案 B（LUMEN 不可用时）：Rust 侧用 `image` + `ab_glyph` 画边框；需要内置一款可商用的中文字体（思源黑体/Noto Sans SC，OFL），并处理字体授权与包体积（约 10MB）。
3. UI：只在 render 模式显示「边框水印」折叠区；4 预设 + 字段多选 + 字号；预览用 1600 预览图即时合成（可选）。

**成本/风险**：6 天（方案 A 约 3 天）。风险：字体许可、CJK 排版、导出尺寸变化；必须在清单里记录水印是否应用，避免「以为加了其实没加」。

### 5.12 CR3 HDR PQ 预览解码（P2）

**LUMEN 做法**
- `previews.py:1-13`：Canon CR3（如 EOS R5 Mark II）的 HDR PQ 文件内嵌的是 HEVC 预览，LibRaw 取不到；LUMEN 用 OpenCV 自带的 FFmpeg 解码，再从 BT.2020 PQ 转 SDR sRGB（参考白 203）。
- `previews.py:24-30`：`PRVW`（1620×1080）与 `THMB`（320×214）两种 box。

**本项目的现状**
- `scanner.rs:19-23` 支持 `cr3` 扩展名，但缩略图走 `kamadak-exif` + `image` crate 的内嵌预览提取；HEVC 预览大概率取不到，回退到全图解码或占位。
- 对 R5 II 用户，这会让「扫描 2000 张 CR3」变慢，甚至没有缩略图。

**落地方式**
1. 先验证：用一张 R5 II HDR PQ 的 CR3 跑现有缩略图管线，确认是否失败；如果失败，再做。
2. 方案 A：Windows 自带的 HEIF/WIC 解码器（`Windows.Graphics.Imaging`），零新增二进制；但需要确认系统组件存在。
3. 方案 B：`libheif-rs`（LGPL-3.0，动态链接）+ 颜色转换；需要处理 PQ→SDR 的色调映射。
4. 方案 C：调用 LUMEN 的 `render.preview`（如果 LUMEN 能打开该 CR3）——最简单，但依赖 sidecar，且 1600px。
5. 无论哪种，都要把「HEVC 预览解码失败」与「RAW 解码失败」区分开，给用户可操作的提示。

**成本/风险**：5 天 + 许可评估。风险：GPL/LGPL 合规（不要打包 GPL 版 FFmpeg）；建议优先 WIC，其次 libheif。

### 5.13 AI 增强（P3，当前被上游堵住）

**LUMEN 做法**
- 9 个 ONNX 模型：Real-ESRGAN 2×/4×、DRUNet/NAFNet/FFDNet 去噪、SkySeg/人物/U2NetP 蒙版；AI 在独立进程运行，崩溃可换设备重算。
- 但**没有对应的命令**：`commands.py` 里没有 `photo.enhance`，MCP 工具表里也没有；`capabilities.rs:31-40` 的注释已经指出「AI 是挂在 `edit.apply` 的 `changes.masks[].region` 上的」。

**本项目的现状**
- `LumenCapabilities.aiEnhance` 字段存在（`types/index.ts:155`），但没有任何 UI 消费它；即使消费，sidecar 也没有可调用的命令。
- 结论：**现在做不了**。要么推动 LUMEN 上游加 `photo.enhance` 命令，要么宿主自己接 ONNX（成本极高，不建议）。

**建议**
- 短期：把 `aiEnhance` 从能力展示里移除，或标注「需要 LUMEN 1.7+」。不要让用户看到「支持 AI 增强」却点不动。
- 长期：如果 LUMEN 1.7 提供命令，再加「导出前降噪/超分」选项；注意它输出的是 DNG 副本，不是原地修改。

### 5.14 宿主 MCP / CLI（P3）

**LUMEN 做法**
- 27 条命令，一个 `run` 分发；GUI/CLI/管道/MCP 共用；命令有稳定 id、Schema、`read_only`。
- `control.py`：Windows 命名管道，仅当前用户可连；JSON Lines 请求/应答；命令在 worker 线程串行执行，触窗操作走 GUI 线程。

**本项目的现状**
- 只作为 MCP 客户端；没有对外命令层。e2e 已经有一套应用内驱动（`e2e/run-inapp.mjs` + `devtools/e2eRunner.ts`），说明「命令化」的测试价值是存在的。

**建议**
- 暂不做。选片器的用户是人；MCP 的典型场景「让 agent 帮我粗筛」需要先有自动质量评估（模糊/闭眼/重复），本项目没有。
- 如果未来做，先做「只读命令 + 批量评级」两类，不要一上来暴露导出/删除。

### 5.15 i18n（P3）

**LUMEN 做法**
- 代码里写简体中文原文，`tr()` 查 `lumen/locales/<语言>.json`；`tools/i18n_catalog.py` 检查缺漏与占位符；9 种语言，安装器也同步。

**本项目的现状**
- 全中文硬编码，22 个 hook + 30 多个组件。做全量 i18n 是 12+ 人日，且会让所有文案改动变慢。

**建议**
- 不出海不做。如果要做，先抽「用户可见的错误/空态/帮助」三类文案，不要一次抽完；用 `t('key', {n})` + JSON 字典，不要引入重型 i18n 框架。

### 5.16 其他可选借鉴（P3，低优先）

| 功能 | LUMEN 做法 | 对本项目的价值 | 建议 |
|---|---|---|---|
| 命令面板 `Ctrl+K` | 所有操作有稳定 id，面板可搜索执行 | 快捷键增多后（色标/1:1/查询）降低发现成本 | 等键位超过 15 个再做 |
| 诊断包 | `diagnostics.py` / `release_diagnostics.py` 收集版本、设置、日志、GPU 记录 | 用户报障时不用来回问环境 | 值得做，1-2 天：导出 zip（版本/设置/最近日志/sidecar 状态） |
| 调色快照 | `model.validate_snapshots`，每张照片可存多组编辑状态 | 本项目 tone 只有 6 参数，快照价值有限 | 暂不做 |
| 预设导入/导出 | 内置预设 + 可导入导出 JSON | 用户自建风格可迁移 | 等有预设管理 UI 再说 |
| 溢出提示 `J` | 高光/阴影剪切警告 | 选片时判断曝光是否可救 | 可在 100% 细节里顺带做，成本低 |

### 5.17 负清单（明确不借）

| 不借 | 原因 |
|---|---|
| 自建 RAW 解码 / 显影管线 | 技术栈不兼容，定位不需要，维护成本不可承受 |
| 镜头校正（lensfun） | LUMEN 已做；复制模式导出原片不需要校正 |
| HDR / 景深 / 全景合成 | 不是选片场景；LUMEN 自己也说「真实序列还需验证」 |
| 400MP 内存映射 / 分块编码 | 没有自建渲染，用不上 |
| 处理版本（process version） | 没有自建管线，无版本可迁 |
| 语音 / 自然语言修图 | LUMEN 已做，宿主重复投入 ROI 低 |
| Qt/PySide 代码 | 技术栈不兼容，只借设计不借实现 |
| 全量 i18n（当前阶段） | 12+ 人日，收益只在出海 |

---

## 6. 本项目已经领先的地方（别抄丢）

1. **JPG/RAW 配对**：`scanner.rs` 的同名配对 + 三态（Complete/JpgOnly/RawOnly）是选片器的地基，LUMEN 完全没有。任何新功能都不能破坏「一个 baseName = 一组」的模型。
2. **双图并排对比**：像素级联动平移、基准锁定、左右互换、双击 2.5×，这是比 LUMEN 的「前后对比」更适合选片的交互。新增的缩放/细节能力必须同时服务三个视口（`PreviewViewport` / `SplitCompareViewport` / `BeforeAfterViewport`），不要只改一个。
3. **缩略图管线**：内嵌预览优先 → `fast_image_resize` 回退 → 磁盘缓存（sha256 + mtime 索引），比 LUMEN 的 Qt 图集更轻。新增色标/角标时不要破坏缓存键。
4. **导出事务性**：临时目录 + 全有或全无 + 清单 + 取消零污染（`export.rs:1-14`），比 LUMEN 的逐张导出更适合交付。学 LUMEN 的批量筛选时，不要把它改成「边导边失败」。
5. **自动更新**：`updater.json` + 签名构建 + NSIS，LUMEN 以手动下载为主。这是分发优势，不要为了「自带 Python 一切」而放弃。
6. **原生 XMP 写入**：不依赖 ExifTool/Perl，安装包小、启动快。LUMEN 的批量 ExifTool 方案在 Python 侧合理，在 Rust 侧没必要照抄。

---

## 7. 风险评估

### 7.1 风险矩阵

概率/影响：高/中/低。等级 = 概率 × 影响。

| ID | 风险 | 概率 | 影响 | 等级 | 缓解 |
|---|---|---|---|---|---|
| R1 | 范围蔓延：从选片器变成半成品编辑器 | 高 | 高 | **极高** | 三条边界：不自建解码、不做合成、不改 RAW；新功能必须通过「选片闭环」评审 |
| R2 | `xmp:Label` 语义冲突导致 Lightroom 色标被覆盖/误读 | 高 | 高 | **极高** | 先解耦（5.1）；读兼容、写不碰；迁移提示 + 回归用例 |
| R3 | 三份真值（XMP / pending / rating_sync）冲突 | 中高 | 高 | 高 | pending 只记意图、成功即删；XMP 永远 canonical；启动对账 |
| R4 | LUMEN 版本钉死 1.6.0 的维护债 | 高（随时间） | 中高 | 高 | 能力探测已有；改为版本范围 + 契约测试；copy 模式永远可用 |
| R5 | 100% 细节的耗时/磁盘 | 中 | 中 | 中 | 按需单张、2GB LRU、失败降级、spike 先行 |
| R6 | 许可合规（MIT/CC BY-SA/LGPL/GPL） | 低中 | 高 | 中高 | 只借思想重写；复制代码加版权声明；不打包 GPL 二进制 |
| R7 | 测试网失效（变异存活） | 中 | 中 | 中 | 每个新分支先写能红的用例；变异替换断言子串（AGENTS.md） |
| R8 | 快捷键冲突/可发现性 | 中 | 低中 | 中低 | 键位表集中定义 + 冲突检测单测 + 帮助面板 |
| R9 | 大数据量（100k 照片）性能 | 中 | 中 | 中 | 索引/分页/增量；建立 10k/50k 基准 |
| R10 | 查询语法门槛 | 高 | 中 | 中高 | chips 为主、语法为辅；示例/自动补全；错误给可用示例 |
| R11 | sidecar 分发（体积/签名/更新） | 中 | 中 | 中 | 资源版本化 + 校验和；不塞 Python 运行时 |
| R12 | 承诺 macOS 但 LUMEN macOS 版滞后 | 低（现在） | 高（未来） | 中 | 不承诺；若要做，先确认 LUMEN macOS 能力矩阵 |

### 7.2 Top 5 深度分析

#### R1 范围蔓延（最高优先级）

- **触发条件**：用户说「既然 LUMEN 能调色，为什么这里不能？」→ 开始加曲线、HSL、蒙版、AI 降噪 → 选片器变成半成品编辑器。
- **影响**：开发资源被吸走；启动变慢、包变大；核心的「万张 60fps」被拖垮；与 LUMEN 的功能重叠导致定位模糊。
- **早期信号**：PR 里出现「解码」「色彩空间」「ONNX」；导出面板的参数超过 10 个；用户开始问「为什么这里调色不如 LUMEN」。
- **缓解**：写一条硬规则进 AGENTS.md——「本仓库不实现像素级图像处理；所有显影需求走 LUMEN sidecar」。新功能评审问三个问题：它是否帮助用户更快做决定？它是否能在 100ms 内反馈？它是否能在 LUMEN 不可用时降级？
- **兜底**：如果某功能必须做，先做「调用 LUMEN」的薄封装，不做自研。

#### R2 `xmp:Label` 语义冲突（已经发生）

- **触发条件**：任何在 Lightroom 里用过绿/红色标的用户，打开本项目；或在本项目按 P/U/0。
- **影响**：色标被误读为旗标（语义错），被覆盖/清空（数据丢）。用户不会立刻发现，直到回 Lightroom 才看到标记乱了——这是最伤信任的一类 bug。
- **早期信号**：用户反馈「我在 LR 里的绿标怎么变成留用了」「色标不见了」；XMP diff 里 `xmp:Label` 在按 P 后从 Blue 变 Green。
- **缓解**：5.1 的四步（解耦、读兼容、pick 本地化、加色标）。**在修好之前，不要发布任何色标 UI**，否则用户会以为两者是同一个东西。
- **兜底**：如果短期不能改写入路径，至少先停止「非 pick 清空 Label」这一条（`xmp.rs:443-448` 的 `_ => String::new()` 与 `xmp.rs:455` 的 reject 分支清空），这是最小、最安全的止损。代价是 `P` 仍会把色标覆盖成 Green（pick 目前只能靠它跨重启存活）；彻底解法是 5.1 的本地 pick 存储，落地后再停止写 Label。

#### R3 三份真值冲突

- **触发条件**：pending 表 + XMP + `rating_sync` 同时存在，且外部程序（LR/C1/LUMEN）也写 XMP。
- **影响**：启动对账时不知道听谁的；可能出现「界面 A、磁盘 B、LUMEN C」。
- **早期信号**：同一个文件在两次启动后评级不同；冲突列表为空但值不一致。
- **缓解**：明确优先级——**XMP（外部可见）> pending（本地意图）> rating_sync（同步游标）**；pending 只记录「尚未成功写入 XMP 的意图」，写成功立即删；`rating_sync` 只服务 LUMEN 推送，不参与最终值裁决。任何读路径都不读 pending 作为展示值。
- **兜底**：如果对账仍不确定，提供「以磁盘为准重新加载」按钮，并保留 pending 供用户重试。

#### R4 LUMEN 版本钉死

- **触发条件**：LUMEN 1.7 改协议/命令/recipe 字段；用户升级 LUMEN；本项目仍钉 1.6.0。
- **影响**：握手失败 → 渲染/预览/AI 全挂；用户看到「版本不匹配」但不知道怎么办。
- **早期信号**：LUMEN release notes 出现协议/命令变更；用户反馈「升级 LUMEN 后本应用不能预览」。
- **缓解**：把 `PINNED_LUMEN_VERSION` 从「精确等于」改为「兼容范围 + 能力探测」；对每个用到的命令写契约测试（参数/返回字段）；在设置页显示「已检测到 1.7.0，当前仅验证 1.6.0，可切换 copy 模式」。
- **兜底**：copy 模式永远可用（不依赖 LUMEN）；渲染失败时自动降级并明确提示。

#### R5 100% 细节的耗时/磁盘

- **触发条件**：RAW-only 用户放大到 100%；连续翻图触发多次全尺寸导出。
- **影响**：首次 6-8 秒白屏（24MP 实测）；缓存按 5MB/张膨胀（1000 张约 5GB）；SSD 写满。
- **早期信号**：缓存目录超过 2GB；用户抱怨「放大要等」。
- **缓解**：按需单张、LRU 2GB、预取仅下一张、导出质量 90-95、失败降级；在 UI 上明确「正在生成 1:1 细节…」而不是无反馈。
- **兜底**：JPG 分组直接用原图；RAW-only 失败时退回 1600 预览并说明原因。

### 7.3 红线与护栏

1. **不自建像素管线**：本仓库不引入 `rawloader`/`libraw`/`onnxruntime` 做显影；所有显影走 LUMEN sidecar。
2. **XMP 是互操作真值**：任何本地存储（pending/rating_sync/SQLite）都不得成为最终展示值的唯一来源。
3. **批量操作三件套**：可撤销、可取消、有清单。缺一不做。
4. **先红后绿**：新分支必须先有能红的测试；变异必须替换断言瞄准的子串，加前缀不算。
5. **不引入 GPL 二进制**：FFmpeg/libheif 只用 LGPL 构建或系统组件；新增依赖先过许可清单。
6. **不改变单手选片主流程**：`0-5 / P / X / U / A / D / 空格 / B / S / M` 的语义不变；新键位只能占用未使用的键，并在帮助面板登记。
7. **禁用按钮必须常驻解释**：不能只放 `title`；读屏与键盘都拿不到（AGENTS.md 已固化）。

---

## 8. 需求分析

### 8.1 用户画像与 JTBD

| 画像 | 规模/场景 | 核心任务（JTBD） | 最痛的点 |
|---|---|---|---|
| 婚礼/活动摄影师 | 单场 2000-5000 张，多卡多目录 | 5 分钟内完成第一轮技术淘汰；按场景/服装精选；交付 | 对焦检查慢；误触无法撤销；交付要手动整理 |
| 风光/旅行摄影师 | 单次 500-2000 张，多机位 | 按机身/镜头/地点分组；与 Lightroom 往返；统一风格 | 色标不能用；查询靠肉眼；套调色靠手点 |
| 摄影爱好者 | 几百张 | 快速挑出好片；少配置 | 快捷键记不住；筛选档位不够用 |

### 8.2 功能需求（FR）

| ID | 需求 | 验收标准（可测） | 优先级 |
|---|---|---|---|
| FR-01 | 旗标/色标解耦 | 按 P/U/0 不再修改 `xmp:Label`；LR 设 Green 后本应用不再显示为 Pick；旧文件 Green→Pick 仅读兼容并有迁移提示 | P0 |
| FR-02 | 5 色色标 | 6/7/8/9 设红/黄/绿/蓝，重复按取消；紫色可经菜单或 Shift+6；缩略图色点；筛选计数一致 | P0 |
| FR-03 | 写盘合并 + pending | 同一照片 500ms 内 5 次改动只落盘 1 次；崩溃后启动回放 pending；已确认操作零丢失 | P0 |
| FR-04 | 多步撤销 | ≥20 步；批量算 1 步；撤销后 UI 与 XMP 一致；外部改动时提示不盲覆盖 | P0 |
| FR-05 | RAW-only 100% 细节 | 可 1:1 查看；**首次 ≤10s（24MP 实测 6-8s，45MP 约 12-16s 需先复测）**；缓存命中 ≤100ms；渲染中可取消且可继续翻图；失败降级有提示 | P0 |
| FR-06 | 查询式筛选 | 支持 rating/flag/label/name/ext/folder/edited + iso/camera/lens/aperture/shutter/focal；`-` 取反；10k 张 <50ms；错误给示例 | P1 |
| FR-07 | 套用调色到选中 | 只复制 6 个 tone 字段；不碰 rating/flag/label；逐项失败报告；可取消 | P1 |
| FR-08 | XMP 增量导入 | 外部 mtime 变化可增量读；冲突三选一；不自动覆盖；汇总提示 | P1 |
| FR-09 | 任务互斥 | 扫描/导出/渲染/AI 按表互斥；禁用按钮常驻原因；无死锁 | P1 |
| FR-10 | 选片集 | `.galleryalbum` 相对路径；换机可开；缺失文件列出；≤2000 张；原子写 | P2 |
| FR-11 | Lightroom 导入 | `.lrcat` 只读；锁定时复制；虚拟副本跳过；默认只填空白；报告未匹配 | P2 |
| FR-12 | 边框水印 | 4 预设；字段可选；仅导出应用；原片不变；清单记录 | P2 |

### 8.3 非功能需求（NFR）

| 类别 | 要求 | 验证方式 |
|---|---|---|
| 性能 | 10k 张扫描/筛选/评级反馈不退化；查询 <50ms；100% 细节首次 ≤10s（24MP 实测 6-8s）、缓存命中 ≤100ms；全尺寸渲染并发上限 1（761MB/次） | 基准脚本 + 实机 |
| 可靠性 | 已确认评级零丢失；XMP 写失败可重试；崩溃可恢复 | 杀进程测试 + pending 回放单测 |
| 互操作 | LR Classic / Capture One / Bridge 读写往返；Rating/Label 语义正确 | 真实文件 + 三软件抽检 |
| 可访问性 | 禁用按钮原因常驻；live region 独占；键盘可达 | a11y 测试 + 读屏抽查 |
| 可维护性 | 新逻辑单文件 <400 行；共享谓词单一真值；契约字段有测试 | 代码评审 + 覆盖率 |
| 安全 | 不新增远程内容；asset scope/CSP 维持现状并评估收紧 | 安全评审 + §7.3 红线 |

### 8.4 RICE 优先级（透明假设）

Reach 1-5（受影响用户比例）、Impact 1-5、Confidence 0-1、Effort 人日；Score = R×I×C/E×10。

| 需求 | R | I | C | E | Score | 排序 | 修正 |
|---|---:|---:|---:|---:|---:|---|---|
| 套用调色 | 4 | 4 | 0.9 | 3 | 48 | 1 | P1（依赖 tone 稳定） |
| 写盘合并 | 4 | 3 | 0.8 | 2 | 48 | 1 | P0（色标前置） |
| 色标 | 5 | 4 | 0.9 | 4 | 45 | 3 | P0 |
| 多步撤销 | 5 | 4 | 0.9 | 5 | 36 | 4 | P0 |
| 查询筛选 | 4 | 4 | 0.8 | 5 | 25.6 | 5 | P1 |
| XMP 增量 | 3 | 3 | 0.8 | 3 | 24 | 6 | P1 |
| 状态机 | 3 | 3 | 0.8 | 3 | 24 | 6 | P1 |
| 选片集 | 3 | 4 | 0.8 | 6 | 16 | 8 | P2 |
| 100% 细节 | 5 | 5 | 0.5 | 8 | 15.6 | 9 | **P0（战略修正）** |
| CR3 HDR PQ | 2 | 5 | 0.5 | 5 | 10 | 10 | P2 |
| 水印 | 3 | 3 | 0.6 | 6 | 9 | 11 | P2 |
| lrcat | 2 | 4 | 0.6 | 6 | 8 | 12 | P2 |
| i18n | 2 | 2 | 0.7 | 12 | 2.3 | 13 | P3 |
| 宿主 MCP | 1 | 3 | 0.6 | 8 | 2.25 | 14 | P3 |

**修正说明**：100% 细节的 RICE 分数被「Effort 8 + Confidence 0.5」压低，但它是「对焦检查」这一核心 JTBD 的必要条件，且没有替代方案（JPG 分组可用，RAW-only 不可用）。因此人工上调为 P0，但必须先做 2 天 spike 验证 `photo.export` 的耗时与画质。

### 8.5 迭代路线

| 迭代 | 主题 | 内容 | 工期 | 出口标准 |
|---|---|---|---|---|
| S1 | 基础语义 | FR-01 解耦、FR-02 色标、FR-03 写盘合并 | 1.5 周（8d） | XMP 往返测试全绿；LR 色标不再被覆盖；500ms 合并生效 |
| S2 | 可逆与检索 | FR-04 多步撤销、FR-06 查询筛选 | 2 周（10d） | 20 步撤销；10k 查询 <50ms；chips 与语法共存 |
| S3 | 批量与对齐 | FR-07 套用调色、FR-08 XMP 增量、FR-09 状态机 | 2 周（9d） | 200 张套用可取消；冲突不自动覆盖；互斥表无死锁 |
| S4 | 核心体验 | FR-05 100% 细节（含 spike） | 1.5 周（8d） | RAW-only 1:1 首次 ≤10s（24MP 实测 6-8s）；缓存 ≤2GB；并发上限 1 |
| S5 | 组织与迁移 | FR-10 选片集、FR-11 lrcat | 2.5 周（12d） | 换机可开选片集；LR 导入报告完整 |
| S6 | 交付与平台 | FR-12 水印、CR3、AI、MCP、i18n | 按需 | 按商业优先级单独排 |

合计约 47 人日 ≈ 9.5 周（单人串行）。S4 与 S2/S3 无代码依赖，可并行，压缩到约 8 周。

> **S1 已全部落地（2026-10-18）**：FR-01 → `adr-001-flag-storage.md`，FR-03 → `adr-002-write-coalescing.md`，FR-02 → `adr-003-colour-labels.md`。出口标准逐条达成：XMP 往返测试全绿（Rust 184 单测，含 Lightroom 风格侧边栏的单值不变式用例）；LR 色标不再被覆盖（写入层按 `rdf:Description` 位置去重，就地改外部那份而非新增）；合并生效（400ms 静默窗口，`syncqueue::Coalescer`）。
>
> **S2 已全部落地（2026-10-18）**：FR-04 → `adr-004-undo-stack.md`（50 步命令栈 + 批量算一步 + 重做 + 撤销前磁盘冲突检查），FR-06 → `adr-005-query-filter.md`（字段语法 + 取反 + glob + 6 个 EXIF 字段）。出口标准逐条达成：「20 步撤销」→ 深度 50；「10k 查询 <50ms」→ 实测 ~18ms；「chips 与语法共存」→ AND 叠加，导出范围复用同一份谓词。

依赖关系：S1 是所有后续的前提（色标与写盘队列）；S2 的查询依赖色标字段；S4 独立，可与 S2/S3 并行（不同人）；S5 依赖 S1 的元数据模型。

### 8.6 度量与验收

**产品指标**
- 首轮淘汰耗时：1000 张从打开到完成第一轮 ≤15 分钟（当前无基线，需先测）。
- 误操作恢复率：撤销使用次数 / 评级操作次数；目标 >5%（说明用户敢用撤销）。
- 100% 检查覆盖率：RAW-only 用户中使用 1:1 的比例；目标 >30%。
- 交付返工率：导出后因漏选/错选返工的比例；目标 <2%。

**工程指标**
- 评级写盘 P95 ≤20ms（本地 SSD）；合并后写盘次数 ≤ 操作次数 / 3。
- 查询 10k 张 P95 ≤50ms。
- 100% 细节缓存命中率 ≥60%（连续翻图场景）。
- 新增分支变异存活率 0（每个新分支至少一条能红的用例）。

**验收方式**
- 每迭代结束跑：`npx tsc --noEmit` + `npx vitest run --pool=vmForks` + `cargo test --lib` + `npm run e2e:render`。
- 真实文件回归：至少 3 个相机品牌（Sony/Canon/Nikon）× 3 种场景（RAW+JPG / RAW-only / JPG-only）× 2 种外部状态（有 XMP / 无色标）。
- 互操作抽检：Lightroom Classic、Capture One、Bridge 各打开一次，确认 Rating/Label 语义。

---

## 9. 结论

### 9.1 三句话

1. **不要学 LUMEN 怎么修图，要学它怎么管图。** 显影管线是它的护城河，也是本项目的陷阱；图库语义与任务纪律才是可迁移、可验证、能直接提升选片体验的部分。
2. **先修数据语义，再加功能。** `xmp:Label` 被旗标占用是当前最严重的问题；不修就加色标，等于在坏数据上盖楼。
3. **100% 细节是必须补的短板。** 选片的核心是「这张对不对焦」，RAW-only 只有 1600px 预览等于让用户猜；这是唯一一个「不做就无法服务核心用户」的缺口。

### 9.2 立即可做的三件事

1. 今天：停止非 pick 分支清空 Label（`xmp.rs:443-448` 的 `_` 分支与 `xmp.rs:455`），并加一条测试锁住「按 U / 0 不清色标」；pick 暂保留 Green 写入，等本地存储落地后再摘掉。
2. 本周：色标字段 + 6/7/8/9 + 缩略图色点 + 筛选计数（FR-02），配 XMP 往返测试。
3. ~~下周：`photo.export` 全尺寸 spike~~ **已完成（2026-10-18，24MP 真实 ARW）**：6-8 秒 / 761MB / 无缓存效应，结论见 5.4；仍需一张 45MP 样片复测外推是否成立。

---

## 附录 A：证据索引

### LUMEN RAW

| 主题 | 位置 |
|---|---|
| 追加日志 / fsync / 撕裂行 / 压缩 | `lumen-raw/lumen/catalog.py:137-209` |
| 三轴字段 / 多语言色标 | `lumen-raw/lumen/catalog.py:33-64` |
| 查询语法 / 匹配 | `lumen-raw/lumen/catalog.py:269-336` |
| XMP 批量读 / 写 | `lumen-raw/lumen/catalog.py:380-440` |
| Lightroom 目录导入 | `lumen-raw/lumen/catalog.py:445-487` |
| 命令注册 / 参数校验 / 分发 | `lumen-raw/lumen/commands.py:34-137` |
| 评级/旗标/色标命令 | `lumen-raw/lumen/commands.py:274-298` |
| 套用 look | `lumen-raw/lumen/commands.py:472-478` |
| 预览/导出命令与上限 | `lumen-raw/lumen/commands.py:524-594` |
| 工作状态机 / 冲突表 | `lumen-raw/lumen/scheduler.py:27-118` |
| 单所有者任务队列 | `lumen-raw/lumen/scheduler.py:149-197` |
| CR3 HDR PQ 预览 | `lumen-raw/lumen/previews.py:1-60` |
| 大图内存映射 / 条带 | `lumen-raw/lumen/large_image.py:7-41` |
| 选片集格式 | `lumen-raw/lumen/library.py:323-380` |
| 边框水印 | `lumen-raw/lumen/watermark.py:9-40` |
| 镜头校正模型 | `lumen-raw/lumen/lens.py:1-30` |
| 控制通道（命名管道） | `lumen-raw/lumen/control.py:1-40` |
| 无头会话 | `lumen-raw/lumen/session.py:1-8` |
| MCP 工具派生 | `lumen-raw/lumen/mcp.py:41-66` |

### Gallery Culling

| 主题 | 位置 |
|---|---|
| 数据模型（两轴） | `src-tauri/src/models.rs:66-81` |
| 固定筛选档 | `src/types/index.ts:21-24`；`src/utils/filterMatch.ts:15-63` |
| 搜索仅文件名 | `src/hooks/useCollection.ts:50-56` |
| 评级写盘 / 单步撤销 | `src/hooks/useRatingFlagSync.ts:92-265` |
| XMP 写 Label / 读旗标 | `src-tauri/src/xmp.rs:440-468`；`xmp.rs:510-524` |
| 命名空间白名单 | `src-tauri/src/xmp.rs:157-199` |
| 评级同步游标 | `src-tauri/src/db.rs:76-104`；`src-tauri/src/commands/xmprw.rs:27-54` |
| 导出事务性 | `src-tauri/src/commands/export.rs:1-14` |
| 预览宽度 1600 | `src/hooks/useLumenPreview.ts:29`；`useViewportImage.ts:37-42` |
| 视口图源规则 | `src/utils/viewportImage.ts:32-52` |
| 版本钉死 / 协议 | `src-tauri/src/lumen.rs:56`；`lumen/mcp.rs:68-103` |
| AI 能力磁盘探测 | `src-tauri/src/lumen/capabilities.rs:31-40` |
| 预览缓存键 | `src-tauri/src/lumen/cache.rs:52-101` |
| 渲染导出 | `src-tauri/src/lumen/runtime.rs:463-498` |

---

## 附录 B：落地骨架

### B.1 色标数据模型（Rust）

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CullLabel { #[default] None, Red, Yellow, Green, Blue, Purple }

impl CullLabel {
    pub fn xmp_name(self) -> &'static str {
        match self {
            Self::None => "", Self::Red => "Red", Self::Yellow => "Yellow",
            Self::Green => "Green", Self::Blue => "Blue", Self::Purple => "Purple",
        }
    }
    /// 读兼容：LR/多语言色标名 → 枚举；未知返回 None。
    pub fn from_xmp(text: &str) -> Self {
        match text.trim().to_lowercase().as_str() {
            "red" | "红色" | "rot" | "rouge" => Self::Red,
            "yellow" | "黄色" | "gelb" | "jaune" => Self::Yellow,
            "green" | "绿色" | "grün" | "vert" => Self::Green,
            "blue" | "蓝色" | "blau" | "bleu" => Self::Blue,
            "purple" | "紫色" | "lila" | "violet" => Self::Purple,
            _ => Self::None,
        }
    }
}
```

### B.2 查询解析（TS 纯函数，节选）

```ts
export type QueryTerm =
  | { field: 'rating'; op: '=' | '>=' | '<='; value: number; negate: boolean }
  | { field: 'flag'; value: 'pick' | 'reject' | 'none'; negate: boolean }
  | { field: 'label'; value: CullLabel; negate: boolean }
  | { field: 'name' | 'ext' | 'folder'; value: string; negate: boolean };

export function parseQuery(input: string): QueryTerm[] {
  // 逐 token：'-' 前缀取反；'field:op:value'；裸词按 name 子串
  // 与 LUMEN catalog.parse_query 语义一致，扩展 iso/camera/lens
}
```

### B.3 写盘合并（Rust，骨架）

```rust
struct PendingWrite { path: PathBuf, rating: u8, flag: String, label: CullLabel, at: i64 }

// 单线程 + mpsc；按 path 覆盖合并；400ms 窗口；退出 flush
fn spawn_writer(db: Database, rx: Receiver<PendingWrite>) -> JoinHandle<()> {
    // 1) 收到写入 → upsert pending_xmp
    // 2) 合并同 path 的后续写入（last-write-wins）
    // 3) 调 write_xmp；成功 delete pending_xmp
    // 4) 失败保留，下次启动回放
}
```

### B.4 状态机（Rust，骨架）

```rust
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Activity { Scan, Export, Render, Ai, Thumbnail }

const BLOCKED_BY: &[(Activity, &[Activity])] = &[
    (Activity::Scan,   &[Activity::Export, Activity::Render]),
    (Activity::Export, &[Activity::Scan, Activity::Render, Activity::Ai]),
    (Activity::Render, &[Activity::Export, Activity::Ai]),
    (Activity::Ai,     &[Activity::Export, Activity::Render]),
    (Activity::Thumbnail, &[Activity::Export]),
];

fn try_begin(state: &WorkState, a: Activity) -> Result<Guard, Vec<Activity>> { /* ... */ }
```

---

## 附录 C：相邻发现（不属于 LUMEN 对照，但建议排期）

1. **持久化路径不规范**：`db.rs:250-265` 的 `gallery_culling.db` 与 `thumbnail/cache.rs:15-40` 的 `app_cache` 都以「当前工作目录」为第一选择，不可写时才退到 temp。开发态没问题；安装版从快捷方式启动时，cwd 可能是安装目录，升级/卸载或权限变化会导致设置、会话、缓存「莫名消失」。建议迁到 Tauri 的 `app_data_dir`，带一次性迁移（旧库存在则复制，不删）。
2. **asset scope 过宽**：`tauri.conf.json` 的 `assetProtocol.scope` 是 `["**"]`，`csp` 为 `null`。本地应用风险有限，但一旦 WebView 内出现 XSS，任意本地文件都可被读取。建议收窄到「用户选过的照片目录 + 缓存目录」，并评估给 `csp` 一个最小策略。
3. **预览宽度常量分散**：1600 同时出现在 `useLumenPreview.ts:29`、`useViewportImage.ts:40` 与 `lumen/cache.rs` 的默认值里。做 100% 细节时必然要引入第二个宽度，建议先把「预览宽度」收进一个常量/配置，避免缓存键与请求宽度漂移。

---

*本报告只做分析与建议，未修改任何生产代码。所有行号以 2026-10-18 工作区为准；若代码已变动，以实际为准并同步更新本文件。*
