# ADR-011：Lightroom 目录导入（FR-11）

- 日期：2026-10-19
- 状态：已采纳
- 相关：报告 `docs/lumen-benchmark-2026-10-18.md` §5.10、FR-11
- 前置事实：真实 LR 目录实测（2026-10-19，`Pictures/Lightroom/Lightroom Catalog.lrcat`，119 张 / 450MB / WAL）

## 背景

目标用户大量来自 Lightroom。迁移时最痛的不是功能差异，是「我在 LR 里已经标好了，
不想重标」。这一项就是把 LR 的评级 / 旗标 / 色标搬过来。

看起来是「读个 SQLite 而已」，实际有三个会安静出错的点：

1. **`rating` / `pick` 在真实库里没有类型声明**。`PRAGMA table_info` 显示类型为空，
   实际存 `REAL` 或 `NULL`。按整数读会 `InvalidColumnType`，整库一张都读不出来。
2. **LR 目录是 WAL 模式且经常正被 LR 打开**。只读打开会撞两种失败：库被独占锁住
   （BUSY）、WAL 里有未 checkpoint 的评级需要写权限做恢复（`attempt to write a
   readonly database`）。
3. **LR 目录是全库**。几万张散在几十个盘上，全量读回来既慢又没法用 —— 而且按文件名
   跨目录匹配会把别的拍摄的星级搬过来。

## 决策

### 1. 只读 + 复制兜底，**绝不写用户的 `.lrcat`**

```rust
Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
```

失败时把 `.lrcat` 与它的 `-wal` / `-shm` 一起复制到临时目录再读，读完删掉。

- **`-wal` 必须一起带走**：只复制主文件会读到「上一个 checkpoint」的状态，用户在
  LR 里刚标的评级恰好还在 WAL 里。
- **任何错误都尝试复制**，不只 BUSY：WAL 恢复失败的错误码是
  `SQLITE_READONLY_RECOVERY`，不是 BUSY，只判 BUSY 会漏掉最常见的那种。
- 结果里 `copied: true` 要在界面上说出来（「Lightroom 正在运行，读的是副本」）——
  否则用户会以为读的是最新状态。

**为什么不写**：那是 LR 的数据库，写坏一次就是整库。要写也只在 LR 关闭时写，
而「检测 LR 是否关闭」本身就是不可靠的。

### 2. 四表联查，`rating` / `pick` 按 `Option<f64>` 读

```sql
SELECT r.absolutePath, f.pathFromRoot, lf.baseName, lf.extension,
       i.rating, i.pick, i.colorLabels, i.masterImage
FROM Adobe_images i
JOIN AgLibraryFile lf ON lf.id_local = i.rootFile
JOIN AgLibraryFolder f ON f.id_local = lf.folder
JOIN AgLibraryRootFolder r ON r.id_local = f.rootFolder
```

`rating` 与 `pick` 用 `Option<f64>`：`f64` 的 `FromSql` 同时接受 `Integer` 与 `Real`，
`Option` 接受 `NULL`。这是唯一能同时兼容「旧库存整数 / 新库存浮点 / 未评级是 NULL」
的读法。

### 3. 虚拟副本跳过并计数

`masterImage IS NOT NULL` 即虚拟副本：同一张底片的另一份调色，路径与主图相同。
导进来只会用副本的评级覆盖主图。跳过并在报告里给数量（「跳过虚拟副本 K 张」）——
静默跳过会让用户怀疑总数不对。

### 4. 旗标：`pick=-1` 与 `rating=-1` **都算** reject

LR 的淘汰有两种写法：`pick = -1`（旗标）与 `rating = -1`（星级）。只认 `pick`
会漏掉「只按了 0 星淘汰」的那批 —— 而那正是最常用的淘汰手势。

`rating = -1` 归一成 0 星，淘汰只由 `flag` 表达（与本项目 `Rating=-1` 的 XMP 约定
一致，见 ADR-001）。

### 5. 色标：逗号分隔取**第一个已知色**，未知忽略

`colorLabels` 是 TEXT（`'Red'` / `'Teal,Green'` / `''`）。LR 允许用户改色标名，
所以可能出现本项目不认识的色名。规则：

- 按逗号切，取第一个能在 `xmp::LABEL_VALUES` 里**大小写不敏感**匹配上的；
- 一个都没有 → `""`（不猜成某个已知色）。

### 6. 路径：`absolutePath` + `pathFromRoot` + `baseName.extension`

- 两段目录都可能缺尾分隔符（`pathFromRoot` 为空是常态，根目录本身就是 `C:/a/`），
  缺了就补 —— 否则拼出 `2026DSC1.ARW`。
- LR 一律存正斜杠，**含 UNC**（`//server/share/...`）。落到 Windows 上要转回 `\`，
  否则与本项目扫描出来的路径永远对不上。
- 不做 canonicalize：那是 IO，而且符号链接的解析结果与 LR 记的不是一回事。

### 7. 后端按 `folders` 白名单过滤，**不全量传**

前端把当前集合涉及的父目录去重后传过去，后端只返回落在这些目录里的照片。

- LR 库常有几万张，全量 JSON 有十几 MB，而且前端拿到也没法用；
- 过滤在 Rust 侧做（路径是拼出来的，SQL 里没有现成的列可比），10 万行扫一遍
  在 50ms 量级。

`total` 仍然是**库内总数**（不受过滤影响），报告里说「库里 N 张」才有意义。

### 8. 匹配：精确路径优先，**同目录同名**次之，绝不全局同名

1. `normalizeFilePath` 后精确相等 —— 最可靠；
2. 都没命中时用「同目录 + 同 baseName」—— LR 里记的是 `DSC1.JPG`、当前集合只有
   `DSC1.ARW`（或反过来）时仍能对上。

**为什么不做全局同名**：`DSC0001.ARW` 在几十个目录里都存在，按文件名套评级会把
别的拍摄的星级搬过来 —— 错误数据比没有数据更糟，而且用户很难发现。报告里
`byName > 0` 时单独说明「其中 N 张是同目录同名对上的」，不让用户以为全是精确路径。

一个 group 只认领一条 LR 记录（LR 里 RAW+JPG 是两条 `Adobe_images`），取先出现的
那条；第二条不算「未匹配」（它只是不重复写），否则报告会谎报「LR 多了一张」。

### 9. 默认只填空白，覆盖要显式勾

`overwrite=false` 时只写**整组空白**（0 星 + 无旗标 + 无色标）的组。

三轴一起判，不逐字段填：只看评级会在「3 星 + 无旗标」的组上补一个 pick，做出
半新半旧的状态，比整组跳过更难解释。

覆盖开关默认关，且**写入张数写在按钮上**（「导入 42 张」）—— 勾选后这个数字会变，
用户按下之前就知道会影响多少张。覆盖是不可逆的（导入前没有快照）。

### 10. 写盘复用 `update_rating_flag_cmd`，逐张 + 进度 + 取消

- **不新增批量命令**：`update_rating_flag_cmd` 是 XMP + `.gallerycull.json` 的唯一
  写入路径（ADR-001/003）。另起一条批量命令等于让「导入进来的评级」和「手动按的
  评级」走两套落盘逻辑，迟早不一致。
- `coalesce=false`：每张只改一次，没必要等 400ms 合并窗口。
- 逐张推进度、协作式取消（与 `useToneBatch` 同一模式）：单张失败不连坐，
  失败项带 `{name, path, reason}` 结构，UI 直接照着念。
- **无值不写、值相同不写**：LR 里也是 0 星 / 无旗标 / 无色标时写它等于无意义写盘，
  还会把 `pending_xmp` 弄脏。

### 11. 互斥用既有的 `batch-write`，不新增活动

导入写的就是批量评级，与批量写盘是同一个冲突源。读阶段（只读 SQLite，不碰集合）
不进互斥表，只用自己的 `reading` 挡重入 —— 给它单独开一个活动会让「读 LR 目录」
把导出按钮变灰，代价远大于收益。

### 12. 入口与选片集分开

顶栏两个按钮：「选片集」与「导入 LR」。选片集是「这批照片是哪些」，导入是
「把 LR 的判断搬过来」，目标状态完全不同；合并进一个弹窗会让用户分不清。

## 真机验证（2026-10-19）

真实 LR 目录 `Pictures/Lightroom/Lightroom Catalog.lrcat`（119 张，450MB，WAL）：

```
[real_lrcat] 119 张 / 跳过虚拟 0 / 库内总 119 / 复制副本 false / 21 ms
```

这条冒烟的价值不在数字，在**证明了真实 schema 读得出来**：单测造的库是理想
schema（`rating REAL`），真实库的 `rating`/`pick` 类型声明是空的、实际存 `REAL`
与 `NULL`，路径是 UNC（`//Vernededesktop/h/...`）。三样都只有真文件能验。

命令：

```bash
GALLERY_REAL_LRCAT="C:/Users/VerNe/Pictures/Lightroom/Lightroom Catalog.lrcat" \
  cargo test --lib real_catalog_smoke -- --ignored --nocapture
```

## 测试

新增 43 例前端 + 18 例后端（另有 1 例 `--ignored` 真机冒烟）：

| 层 | 文件 | 数量 | 覆盖要点 |
|---|---|---|---|
| 读取 | `lrcat.rs` | 14 + 1 ignored | 评级/旗标/色标映射、虚拟副本跳过并计数、`rating=-1` 算淘汰、评级夹到 5、子目录拼接（缺尾斜杠不拼成 `2026DSC1`）、目录过滤（大小写/尾斜杠）、空 `folders` = 不过滤、未知色标忽略、多色标取首个已知、色标大小写归一、非 LR 库可读错误、文件不存在、**EXCLUSIVE 锁下复制兜底**、真实目录冒烟 |
| 命令层 | `lrcatcmds.rs` | 4 | 空路径拒绝、文件不存在、结果带 catalog 路径与计数、`folders` 透传 |
| 匹配 | `utils/lrcatMatch.ts` | 16 | 路径命中（RAW / 配对 JPG）、同目录同名命中、**跨目录同名不命中**、大小写与分隔符归一、未匹配进列表、同一组只认领一条、`missingInLr` 计数、空输入、`baseNameOf`、`isBlankGroup` 三轴、默认只填空白 / 覆盖全写 / 无值不写 / 值相同不写 |
| 编排 | `hooks/useLrcatImport.ts` | 13 | 没扫描先说明、取消静默、只传当前目录、读到 0 张的解释、读失败不留半截报告、plan 计数、默认只填空白且 `coalesce=false`、覆盖全写、单张失败不连坐、成功后收起、互斥挡住、无可写项的解释、取消保留已写 |
| 弹窗 | `components/LrcatDialog.tsx` | 12 | 未读时只给入口、库规模与三格统计、复制副本提示、虚拟副本计数、默认不覆盖、勾选后张数变化、0 张禁用并说明、未匹配折叠展开、同名匹配说明、失败列表带原因、进度与取消、忙碌时禁止关闭 |
| 集成 | `App.lrcat.test.tsx` | 2 | 点「导入 LR」开弹窗且没扫描时被挡住、扫描后读→匹配→写盘参数是整组状态 |

**变异验证 7 处 7 抓**：

- 后端 3：`flag_of` 去掉 `rating=-1` 分支 → `negative_rating_maps_to_reject` 红；
  虚拟副本不跳过 → `virtual_copies_are_skipped_and_counted` 红；色标改成大小写敏感
  → `label_case_is_normalised` 红。
- 前端 4：同名匹配去掉目录 → `跨目录同名不命中` 红；`isBlankGroup` 只判评级 →
  `任一轴有值就不算空白` 红；`coalesce` 改 `true` → 写盘参数用例红；去掉取消检查
  → `取消后不再写剩下的` 红。

回归：`tsc --noEmit` 0 错；前端 `80 files / 790 passed`；Rust `312 passed /
6 ignored`；clippy 只剩 `export.rs` 两处既有的 `too many arguments (9/7)`。

## 代价与风险

1. **只搬三样，不搬编辑**。develop 设置、蒙版、历史、集合、关键词都不导。
   这是刻意的：LR 的 develop 是它自己的引擎，搬过来没有对应的渲染器，
   假装导入了只会让用户以为调色没丢。
2. **路径必须能对上**。LR 里记的是导入时的绝对路径，照片被移动/改名后对不上。
   `relativePathFromCatalog` 字段理论上能补救（LR 自己就是这么找的），但当前
   没用 —— 它相对的是 catalog 文件，而用户的 catalog 常在另一个盘。
3. **同目录同名是推断，不是事实**。`DSC1.JPG` 与 `DSC1.ARW` 在这套命名下确实
   是同一组，但理论上可以是两张不同的照片。报告里单独标出数量，用户能自己判断。
4. **大库的读取时间未测**。119 张 21ms，10 万张按线性外推约 18 秒（主要是 SQLite
   扫描 + 字符串拼接）。`folders` 过滤发生在 Rust 侧，SQL 仍要全表扫 —— 真到
   10 万张要么加 `WHERE` 下推（路径拼在 SQL 里），要么接受这个延迟并给进度。
5. **覆盖不可逆**。没有「导入前的快照」，勾了覆盖再想撤回只能靠撤销栈（逐张撤销
   100 次）。缓解是默认不覆盖 + 张数写在按钮上；根治要做「导入前存一份 album」，
   优先级低于当前范围。
6. **色标名被用户改过就丢**。LR 允许把色标改成任意名字（`Teal`），本项目只认
   五个标准色。丢了不报错也不计数 —— 因为「LR 的 Teal 对应哪个色」本身没有答案。
7. **写盘是逐张 IPC**。1000 张约 1000 次调用，每次 10–50ms 写盘，总时长 10–50 秒。
   有进度和取消，但没有并发 —— XMP 写入本来就该串行（ADR-002 的合并队列也是
   单线程语义）。
8. **复制兜底会临时占用磁盘**。450MB 的库复制一份到临时目录，读完即删；极端情况
   （磁盘满）会失败并报错，不会静默读到旧数据。
9. **虚拟副本的评级被丢弃**。用户在 LR 里可能只给虚拟副本打了星（主图没打）。
   跳过虚拟副本意味着这条评级丢失。要救得按「路径 + 副本名」区分，但本项目的
   分组模型没有虚拟副本概念 —— 这是模型差异，不是实现偷懒。

## 后续

要补的两件事，按价值排序：

1. **`WHERE` 下推**：把目录过滤写进 SQL（`r.absolutePath LIKE ?`），大库只读
   需要的行。现在 119 张看不出差别，10 万张时是 18 秒 vs 0.2 秒。
2. **导入前快照**：勾覆盖时先把当前集合存成 `.galleryalbum`（FR-10 已有格式），
   给「导错了」留一条退路。
