# ADR-001：旗标独立存储（每文件夹 `.gallerycull.json`）

- 日期：2026-10-18
- 状态：已采纳，实施中
- 关联：`docs/lumen-benchmark-2026-10-18.md` §4 FR-01

## 背景

`xmp:Label` 被同时用作两件事：Lightroom 的**色标**（红/黄/绿/蓝/紫）与本应用的**留用标记**。

证据：

1. `src-tauri/src/xmp.rs:443-448`：`pick` 写 `Label=Green`，其余分支写空串。
2. `src-tauri/src/xmp.rs:455`：`reject` 也清空 Label。
3. `src-tauri/src/xmp.rs:519-521`：读侧把 `Label=Green` 读成 pick、`Label=Red` 读成 reject。
4. `src-tauri/src/db.rs`：只有 `settings` / `rating_sync` / `sessions`，**没有任何照片元数据表**；旗标每次扫描都从 XMP 反推（`scanner.rs:252-253`、`331`）。

后果：

- 用户在 Lightroom 里打的绿/红色标会被误读成留用/淘汰；
- 按 `P` 覆盖色标，按 `U`/`0` 直接清空色标（不可恢复）；
- 反过来，`Label=Green` 残留会让「清除留用」在下次扫描时复活，所以清空 Label 是**唯一**能清旗标的办法 —— 它不是疏忽，是设计缺陷逼出来的。

补充事实：Lightroom 自己也不把 pick 写进 XMP（pick 是 catalog-only）。当前做法并没有换来真正的互操作，只是借用了色标字段。

## 决策

**旗标独立存储：每个文件夹一份 `.gallerycull.json`；XMP 只保留标准语义（`xmp:Rating`、`xmp:Label` 色标、`crs` 调色）。**

- `Rating=-1` 仍表示淘汰（Lightroom / LUMEN RAW 通用约定），继续写 XMP。
- 留用（pick）不再写 `xmp:Label`；色标字段归还给色标。
- 选它而非自定义 XMP 命名空间：`build_our_description` 有「输出字节必须与既有侧边栏一致，否则 Lightroom 可能当成模板更换并重写 develop 数据」的约束（`xmp.rs:166-170`），加 `xmlns:gc` 会打破该不变量，风险落在用户调色数据上。
- 选它而非 SQLite：文件夹拷走、换机、重装都不丢；路径做键的表在目录改名后即失效。

## 数据格式

```json
{
  "version": 1,
  "updatedAt": 1760000000,
  "entries": {
    "dsc_0001": { "flag": "pick" },
    "dsc_0002": { "flag": "reject" },
    "dsc_0003": { "flag": "none" }
  }
}
```

- 键是**小写** base name（与配对用的 `stem_lower` 同一身份），避免 `DSC_0001.JPG` / `dsc_0001.NEF` 大小写不一致时查不到。
- `flag ∈ {pick, reject, none}`，其它值视为损坏并拒写。
- `label` 字段预留给五色色标，当前不写；写旗标时**保留**已有 `label`。
- 未知字段忽略（向前兼容），`version` 高于本程序则拒写。

## 读写优先级

读（扫描）：

1. `xmp:Rating = -1` → **reject**（硬信号，任何外部工具写的淘汰都立刻生效）；
2. 否则查 store：有条目即以条目为准（`"none"` 也算条目 —— 这是压住旧 `Label=Green` 的手段）；
3. 无条目 → 回落旧约定 `Label=Green→pick` / `Label=Red→reject`（只读，不改写文件）。

写：

- 旗标：store 的 `entries[base]`；
- 评级 / 淘汰：`xmp:Rating`（淘汰为 `-1`）；
- 色标：`xmp:Label`，仅在用户显式设色标时写（本期不做 UI）。

### 色标归属（防止写出两个 `xmp:Label`）

`read_xmp_full` 读的是**整份文档**，会把 Lightroom 方块里的色标也读出来。若原样写回
本方块，同一个文件里就会出现两个 `xmp:Label`（XMP 的简单属性只允许一个值）。

规则：`read_sidecar` 只保留 `Green`，其它色标一律在本方块里清空。

- `Green` 是本方块**唯一可能拥有**的色标 —— 旧版本用它编码 pick。保留它，改调色/镜头
  时才不会把用户没动过的「留用」抹掉（`legacy_green_pick_survives_tone_update`）。
- `Blue/Red/Purple/Yellow` 必然来自对方方块，清掉不丢数据（原件还在对方方块里），
  且避免造出重复属性（`reject_writes_minus_one_rating_and_keeps_colour_label` 用
  「`<xmp:Label>` 只出现一次」锁住）。
- 将来做色标 UI 时，必须同时引入来源标记（本方块自有 vs 外部），否则这条规则会误删。

## 失败语义

- `load` 宽松：文件缺失/损坏都返回空 store，**绝不阻断扫描**。
- `upsert` 严格：文件损坏或版本更高时**报错拒写**，不降级成"重建空文件"（与 `append_our_block` 同一纪律）。
- 写入原子：同目录临时文件 + `rename`；全局 `Mutex` 串行化读-改-写，避免并发丢更新。

## 迁移

- 旧文件里的 `Label=Green` 仍被读成 pick（不丢用户已有标记）。
- 用户首次对某张照片操作旗标时写入条目；此后以条目为准。
- 用户按 `U` 清除 → 写 `"none"` 条目 → 旧 Green 被压住，不再复活。
- 不回写、不批量改写用户文件。

## 明确不做（本期）

- 色标 UI 与快捷键（依赖本 ADR 落地后再做）。
- 批量写盘的合并/去抖（FR-03，单独做）。
- 删除 store 中已不存在照片的条目（宁留垃圾，不误删用户标记）。

## 验收用例

1. 旧文件 `Label=Green` + 无 store → 扫描得 pick。
2. 同上 + store 条目 `none` → 扫描得 none（旧标记被压住）。
3. 按 `U` → XMP 里 `Label=Green` **原样保留**，`Rating=0`，store 条目 `none`。
4. 按 `P`：store 条目 `pick`；新文件不再产生 `Label=Green`。旧文件里已有的
   `Green` 保留（`read_sidecar` 只保留这一个值），但不会新写。
5. 外部（Lightroom/LUMEN）写 `Rating=-1` + store 条目 `pick` → 扫描得 reject。
6. store 文件损坏 → 扫描不报错（得旧约定结果），但写旗标报错且文件字节不变。
7. 带 `Label=Blue` 的 Lightroom 文件被写一次 → `Blue` 只剩一处（不复制进本方块）。
