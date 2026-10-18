# ADR-003：五色色标（`xmp:Label`）

- 状态：已采纳（2026-10-18）
- 关联：ADR-001（旗标迁出 `xmp:Label`）、ADR-002（写盘合并）
- 需求：`docs/lumen-benchmark-2026-10-18.md` FR-02

## 背景

ADR-001 把 pick/reject 从 `xmp:Label` 迁到每文件夹的 `.gallerycull.json`，
把 `xmp:Label` 归还给它的本义 —— Lightroom 的五色色标。本 ADR 决定这个字段
怎么读、怎么写、和旗标怎么共存。

`xmp:Label` 是**单值属性**（RDF 简单属性，一个资源一个值）。本应用与 Lightroom
会往**同一份侧边栏**里写各自的 `rdf:Description` 块：

```
<rdf:RDF>
  <rdf:Description ...>        ← Lightroom 的块（含 develop 数据、关键词、色标）
  <rdf:Description ...>        ← 本应用的块（评级 / 镜头 / 调色 / 色标）
</rdf:RDF>
```

两边各写一份 `xmp:Label` = 同一属性两个值。读取方取谁取决于实现细节，
Lightroom 重写文件时还可能把另一份吃掉。这是本 ADR 要解决的核心问题。

## 决策

### 1. 唯一真值是 XMP，不往 `.gallerycull.json` 再存一份

色标与星级同类（Lightroom 认识、需要双向可见），与旗标不同类（本应用发明）。
所以：

| 标记 | 存储 | 理由 |
|---|---|---|
| 星级 | `xmp:Rating` | Lightroom 原生字段 |
| 淘汰 | `xmp:Rating = -1` | Lightroom / LUMEN 通用约定 |
| 旗标 pick/none | `.gallerycull.json` | 本应用发明，XMP 里没有对应字段 |
| 色标 | `xmp:Label` | Lightroom 原生字段 |

代价：写盘失败时色标只存在于界面（与星级一样），由既有的"未同步"角标 +
`pending_xmp` 回放兜底。收益：不存在"store 说红、XMP 说蓝"的双真值冲突，
用户用 Lightroom 改了色标，下次扫描就能看到。

### 2. 单值不变式：一个文件里最多一份 `xmp:Label`

写入层（`xmp::write_meta_with_existing`）统一执行：

1. 先定位本方块（`find_our_block_range`，判定规则与替换逻辑同一份）；
2. 若**本方块之外**已有一份 `xmp:Label` → 本方块不再写色标；
3. 若没有 → 本方块按 `meta.label` 写（空则不写）。

于是"改调色/改镜头"这类**不涉及色标**的写入不会复制出第二份 —— 这是
ADR-001 时期 `read_sidecar` 里"只保留 Green"那条规则的替代品。那条规则是
按色名猜归属，会误删用户设的色标；新规则按**位置**判断归属，不猜色名。

### 3. 改色标 = 就地改那唯一一份

`write_xmp(path, rating, flag, Some(label))`：

- `None` —— 不动色标（评级/旗标写入走这条）；
- `Some("")` —— 清除：删掉文档里所有 `xmp:Label`（含外部块里的那一份）；
- `Some("Red")` —— 设值：若外部块有，**只替换它的值**，其余字节原样保留；
  若没有，写进本方块。

只改值、不重建外部块，是为了不碰 Lightroom 的 develop 数据 —— 那是本项目
最不能出错的地方（`splice_our_block` 的整段注释都在讲这件事）。

支持两种写法：`<xmp:Label>Red</xmp:Label>` 与 `xmp:Label="Red"`。

### 4. 色标与星级/旗标**整组**提交，随同一个意图折叠

`Intent` 增加 `label` 字段，`pending_xmp` 增加 `label` 列（旧库用
`ensure_column` 补列）。原因有两条：

- **折叠不能丢字段**：按 `4` 再按 `6`，两个意图在 400ms 窗口内合并。若色标
  是独立命令，两条命令各自读-改-写同一份 XMP，后写的会把先写的覆盖掉
  （read-modify-write 没有跨命令的串行化）。
- **回放要能还原完整状态**：pending 里只存 rating/flag 而丢掉 label，
  崩溃回放会把色标写回旧值。

命令契约因此是"整组状态"而不是增量补丁：调用方每次都传当前色标，
`''` 表示这张照片现在没有色标。省略 = 按无色标处理。

### 5. 交互：重复按同一个色标 = 取消；批量是"设为"

- 单张：`6/7/8/9` = 红/黄/绿/蓝，`Shift+6` = 紫，再按同一个 = 清除。
  紫色必须按 `e.code === 'Digit6'` 判断 —— `Shift+6` 的 `e.key` 是 `^`。
- 批量：绝对设值，不逐张切换。20 张里已有 3 张红标时，逐张切换的结果
  取决于各自原值，用户无法预期。
- `0` / `U` 只清星级与旗标，**不动色标**：它们是两个维度。

### 6. 已知歧义：旧文件的 `Label=Green`

ADR-001 之前，pick 写成 `xmp:Label=Green`。升级后这些文件会显示为
"pick + 绿标"。刻意不做数据迁移：

- 无法可靠区分"旧 pick 标记"与"用户在 Lightroom 里设的绿标"；
- 任何自动迁移都会改写用户磁盘上的既有数据，风险大于收益。

行为：按 `8`（绿标）会把它当成已有绿标 → 取消，同时把当前旗标写进 store
（`DiskSink` 总是先 upsert 旗标），所以 pick 不会因为清色标而丢失。

## 明确不做

- **不把色标存进 `.gallerycull.json`**（见决策 1）。
- **不把 LUMEN 的色标同步过来**：LUMEN 有 11 种语言色名，与本应用五色不是
  同一套语义；`lumencmds` 拉取评级时显式传 `None`。
- **不做逐张切换式批量色标**（见决策 5）。
- **不在本 ADR 处理色标筛选的查询语法**：当前是筛选下拉里的五个档位，
  FR-06 的 `label:red` 语法会取代它。

## 验收用例（均已落地为测试）

| 场景 | 断言 | 用例 |
|---|---|---|
| 无侧边栏设红标 | 文件里恰好一个 `xmp:Label=Red` | `setting_label_writes_exactly_one_label` |
| LR 块已有 Blue，改红 | 只剩一个 Red，关键词/dc 原样 | `setting_label_replaces_foreign_label_in_place` |
| 清除本方块里的色标 | 无任何 `xmp:Label` | `clearing_label_removes_every_occurrence` |
| 清除 LR 块里的色标 | 无 `xmp:Label`，第三方数据完好 | `clearing_foreign_label_keeps_third_party_data` |
| LR 块有 Blue，改调色 | 仍只有一个 Blue | `tone_update_does_not_duplicate_foreign_label` |
| 改评级（`label=None`） | 色标不变 | `rating_write_without_label_keeps_existing_label` |
| 非法色标 | 报错且不创建文件 | `invalid_label_is_rejected_and_writes_nothing` |
| 扫描带出色标 | `group.label == "Blue"`；无侧边栏为 `""` | `scan_reads_colour_label_from_sidecar` / `scan_without_sidecar_has_empty_label` |
| 意图折叠带色标 | 后到覆盖先到，两个等待者都拿到 Blue | `label_is_coalesced_with_the_latest_intent` |
| pending 补列 | 旧库补 `label` 列且不丢行 | `old_pending_table_gets_label_column` |
| 回放写色标 | DB → Intent → DiskSink → XMP 全链 | `replay_writes_colour_label_to_sidecar` |
| 重复按取消 | 写空串 | `重复按同一个色标 = 取消` |
| 改星级不丢色标 | 调用参数带当前 label | `改星级必须透传当前色标` |
| 批量色标 | 每张一次、`coalesce=false`、值为目标色 | `批量色标是"设为"` |
| 色点渲染 | 有色标才有色点，与旗标角标并存 | `ThumbnailGrid —— 色标色点` |

变异验证（改坏后测试必须变红，已逐条执行并还原）：

1. 写入层去重失效（`write_label = true`）→ 两份色标被抓；
2. 去掉外部块的原地改值 → 设置/清除两条被抓；
3. `setLabel` 不做切换判断 → 取消用例被抓；
4. `rate` 漏传 label → 透传用例被抓；
5. `Shift+6` 按 `e.key` 判断 → 紫色用例被抓；
6. 缩略图不渲染色点 → 色点两条被抓；
7. 批量忽略目标色标 → 批量用例被抓；
8. `DiskSink` 丢弃 label → 回放用例被抓。
