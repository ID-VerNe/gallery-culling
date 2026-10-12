# C — XMP 读写与评级系统 file-by-file 比对

- **宿主**: `gallery-flask` (Tauri 2 + Rust) — `src-tauri/src/xmp.rs` (338 行), `scanner.rs` (526 行), `db.rs` (161 行), `commands.rs`
- **客体**: `lumen-raw` v1.6.0 (commit `43b4ebe`) — `lumen/catalog.py` (487 行), `lumen/cli.py`, `lumen/commands.py`, `lumen/library.py`, `lumen/rating.py`, `lumen/session.py`
- **只读铁律遵守**: 全程 read/grep, 未修改两库任何文件。
- **配套**: 总计划 `.plan/lumen_raw_integration_plan.md` §3.0/§3.1 是本次结论的上游; 本报告把其中"必须"落成函数+行号。

## 结论速览 (TL;DR)

1. **宿主 `write_xmp_full` 是整文件重写**, 只保留自己认识的 11 个字段 (`xmp.rs:70-108` 读、`:120-183` 写), 侧边栏里的一切第三方命名空间全部被抹掉。
2. **客体 `catalog.write_xmp` 用 ExifTool 合并写**, 只碰 `xmp:Rating` / `xmp:Label` 两个标签 (`catalog.py:428-429`), 其它标签天然存活; 客体**从不写 `crs:` 调色, 也从不写任何 `lumen:` 命名空间**(全文 grep 只有 `xmp:Rating`/`xmp:Label` 两处写入, 见 §1.4)。
3. **评级真值位置不对称**: 宿主 SQLite 只有 settings/sessions 两表 (`db.rs:17-36`), 评级真值 = XMP 侧边栏; 客体真值 = `catalog.jsonl` 追加日志 (`catalog.py:107-264`)。宿主要做增量同步**必须**给 `db.rs` 加游标表 (§4.3)。
4. **同步链路不触达 2000 张上限**: `library.rate/flag/label` 与 `xmp read` 都绕过 `library.add` 的 2000 检查 (`commands.py:248-249`), 因为它们不要求照片在库内 (`_targets` `commands.py:165-174` 仅 resolve 路径)。真正受限的是 GUI 图库与选片集 (`library.py:361`), 与同步无关 (§4.5)。
5. **reject 语义必须二选一落地**: 宿主旧写 `xmp:Label=Red` (`xmp.rs:215`), 客体约定 `xmp:Rating=-1` (`catalog.py:425`); 宿主读取端把 `-1` 解析成 1 星 (`xmp.rs:71-81`), 必须修 (§2.3 + §6)。

---

## 1. 写路径比对

### 1.1 谁写什么标签

| 侧 | 入口函数(:行) | 写出的标签 | 未知命名空间 | 备注 |
|---|---|---|---|---|
| 宿主 | `xmp.rs:118-206 write_xmp_full` | 模板**硬编码**: `xmp:Rating`, `xmp:Label`, `aux:Lens`, `aux:LensModel`, `exif:FocalLength`, `exif:FNumber`, `crs:Exposure2012/Highlights2012/Shadows2012/Temperature/Tint/Contrast2012` (:194-195 模板, :165-183 生成) | **不保留** (整文件 `fs::write` :203) | 模板只声明 4 个 ns: `xmp/aux/exif/crs` (:190-193) |
| 宿主 | `xmp.rs:209-219 write_xmp` | 同上; 仅改 rating + label(flag→label :213-217) | 不保留 | read-modify-write, 但"保留集"只有上述 11 个字段 |
| 宿主 | `xmp.rs:222-240 update_xmp_tone` / `:243-261 update_xmp_metadata` | 同上 | 不保留 | 同一个 `write_xmp_full`, 同样毁标签 |
| 宿主 | `commands.rs:40-55 update_rating_flag_cmd` | 调 `write_xmp` (sync_xmp 时) | — | 前端恒传 `syncXmp: true` (`src/App.tsx:443,465`; `src/services/api.ts:39`) |
| 宿主 | `commands.rs:58-82 batch_update_metadata_cmd` / `:258-277 update_tone_adjustments_cmd` | 调 `update_xmp_metadata` / `update_xmp_tone` | 不保留 | 调色/元数据变更同样触发整文件重写 |
| 宿主 | `commands.rs:202-209` 批量导出 | 拷贝 `.xmp` 到导出目录 | — | `xmp_src = src.with_extension("xmp")`, 与 `xmp.rs:22-24 get_xmp_path` 一致 |
| 客体 | `catalog.py:417-440 write_xmp` | `-XMP-xmp:Rating=`, `-XMP-xmp:Label=` (:428-429) | **保留** (ExifTool 合并写, `_sidecars`/`sidecar` :341-348 定位 `<name>.xmp` 与 `<name>.ext.xmp`) | 只写真, 从不改原图 (`catalog.py:11-14`; `commands.py:301` summary) |
| 客体 | `catalog.py:413-414 write_xmp_later` | 同上, 异步线程 | 保留 | 仅当 `write_xmp_on_change` (:244-245) |

**关键不对称**: 宿主调色 (`update_tone_adjustments_cmd`) 走整文件重写 → **会毁掉 lumen 刚写的 `xmp:Label`**; 客体调色由 `.lumen` 工程承担 (`model.py` recipe / `project.save`), 完全不碰侧边栏 (`integration_plan.md:167`), 所以反向无此问题。

### 1.2 宿主触发时机 vs 客体触发时机

| | 宿主 | 客体 |
|---|---|---|
| 评级变更 | 每按一次星级/旗标, `App.tsx:430-471` 单发 `update_rating_flag_cmd` → 写**一张**侧边栏 (RAW 优先 `targetGroup.raw?.path \|\| targetGroup.jpg?.path` :433/:457) | `catalog.set` :221-251 追加一行日志 + fsync (:192); 若 `write_xmp_on_change` 再异步写真 (:244-245) |
| 批量 | `batch_update_metadata_cmd` 逐张串行循环 (`commands.rs:70-77`) | `library.write_xmp` 一次 ExifTool `-@` 批量 (`catalog.py:430-436`) |
| 自动写真同步开关 | **无开关**; `sync_xmp` 参数前端恒 true (`api.ts:39`) | setting `library_xmp` (`catalog.py:49-55`), 默认关; GUI 可切 (`rating.py:249-260`) |
| 存储载体 | 直接覆盖侧边栏 (无日志) | 先追加日志, 后写侧边栏 (日志是唯一真值, 见 §3) |

### 1.3 宿主整文件重写会摧毁的标签 (以代码实际产出为准)

以下按"谁生成"列。**宿主重写后全部消失**, 客体/ExifTool 写则全部保留。

| 命名空间 / 标签 | 生成方 | 宿主读吗 (`read_xmp_full`) | 宿主重写后 |
|---|---|---|---|
| `lumen:Recipe` / `lumen:*` 任意标签 | 客体**当前版本不生成**(见 §1.4); 是未来 patch 可能引入的 | ❌ 不读 | 💥 丢 |
| `lr:hierarchicalSubject` (Lightroom 关键词层级) | Lightroom Classic | ❌ | 💥 丢 |
| `dc:subject` / `dc:title` / `dc:description` / `dc:creator` | Lightroom / Bridge | ❌ | 💥 丢 |
| `exif:GPSLatitude/Longitude` 等 GPS | 相机 / Lightroom | ❌ (宿主只读 `exif:FocalLength`/`exif:FNumber` :86-87) | 💥 丢 |
| `crs:*` 除 6 个调色项外的全部 (白平衡/对比度/清晰度/HSL/噪点/裁剪/镜头校正/…, LR 实际写 80+) | Lightroom / Camera Raw | ⚠️ 只读 6 个 (:89-94) | 💥 丢 |
| `photoshop:*`, `iptc:*`, `xmpDM:*`, `xmpMM:DocumentID` | Lightroom / Bridge / PS | ❌ | 💥 丢 |
| `dc:subject` 内的 `rdf:Bag` 结构 | Lightroom | ❌ | 💥 连 XML 结构一起丢 |
| 已存在的 `xmp:Rating`/`xmp:Label` 之外的 `aux:*`, `tiff:*` | Lightroom | ❌ | 💥 丢 |
| 外来的 `<?xpacket>` padding (LR 写 2KB 空白对齐) | Lightroom | — | 💥 换成宿主 350 字节模板 |

**唯一切死的例外**: 宿主的 read-modify-write 只对**自己写过的** 11 个字段有效。也就是说宿主**自我兼容**(Luminar roundtrip 链路 :222-240), 但**与任何外部写方不兼容**。这正是 `integration_plan.md:133` 的闸门任务。

### 1.4 客体写侧边栏的完整能力边界 (实测代码)

`catalog.py:428-429` 只发两个标签赋值, 因此:
- 客体只写 `xmp:Rating` 与 `xmp:LMP:Label` 两个标签, 已存在的其余标签由 ExifTool 保留 → **客体侧是无损的**。
- 客体**从不**写调色参数到侧边栏 (无 `crs:` 相关调用, grep 全库仅 `catalog.py:428-429` 一处 XMP 写入)。
- 客体侧边栏可能长这样 (ExifTool 生成): 仅 `xmp:Rating` + `xmp:Label` + ExifTool 自己的 `x:xmptk` 头, 无第三方 ns → 宿主重写它不丢东西。**丢数据风险全部来自 Lightroom 写的侧边栏**。

---

## 2. 读路径比对

### 2.1 宿主读侧边栏的优先级链

| 场景 | 函数(:行) | 顺序 | 已知缺陷 |
|---|---|---|---|
| Viewer 模式 (仅 JPG) | `scanner.rs:296-346` | JPG 侧边栏 | `check_sidecar_exists` :27-34 先查 `.xmp` 再查 `.acr`; `.acr` 存在则 `has_xmp=true` 但 :300-301 只读 `.xmp` → 侧边栏标记亮、评级读不到 |
| 配对模式 | `scanner.rs:367-403` | **RAW 优先** (:373-387), RAW 无侧边栏才退 JPG (:388-403) | JPG 已在 RAW 之后 `else if`; 若两者都有侧边栏,**JPG 的评级被静默忽略** (LR 典型工作流: JPG 侧边栏) |
| `check_sidecar_exists` | `xmp.rs:27-34` | `.xmp` → `.acr` | `.acr` 分支返回 true 但无人解析, 见上 |
| `read_xmp_full` | `xmp.rs:63-109` | — | rating 解析 :71-81 是**裸扫字符串**: `find("xmp:Rating")` 后取前 40 字符里第一个 ASCII 数字 → 见 §2.3 |

### 2.2 客体读 XMP 的优先级链

| 场景 | 函数(:行) | 行为 |
|---|---|---|
| 后台自动导入 | `library.py:117-119` → `rating.py:389-401 read_xmp_async` | 只对 catalog **未知**的照片 (`:390 overwrite=False` 时过滤) → **catalog 日志优先于 XMP** |
| 手动菜单 | `rating.py:408-411 read_selected_xmp` → `read_xmp_async(paths, overwrite=True)`| `overwrite=True` → `catalog.merge(values, overwrite=True)` (`catalog.py:253-260`) → **XMP 覆盖 catalog** |
| CLI | `cli.py:196-200` `lumen-cli xmp read` | 直接 `merge(read_xmp(paths), overwrite=True)` → XMP 覆盖 |
| 读取来源 | `catalog.py:380-410 read_xmp` | 侧边栏优先 (`_sidecars` :346-348 两种命名), **无侧边栏则读照片内嵌 XMP** (:384-385 `str(found[0] if found else path)`) — 这是宿主没有的能力 |
| ExifTool 调用 | `catalog.py:390-396` | **200 张一批** (`range(0, len(names), 200)` :390), `-j -charset filename=UTF8 -XMP-xmp:Rating# -XMP-xmp:Label` (:393) |
| 字段映射 | `catalog.py:366-377 _fields_from_tags` | `Rating < 0` → `flag='reject'` (:370-372); 否则 `rating = clamp(round(Rating))`; `Label` → `label_from_text` (:58-64) 支持 11 种语言/别名 |

### 2.3 Rating / Label 语义对齐表

| XMP 里的值 | 客体解析结果 (`catalog.py:366-377`) | 宿主解析结果 (`scanner.rs:306-315` + `:380-384`) | 差异 |
|---|---|---|---|
| `xmp:Rating=3` | `rating=3` | `rating=3` | ✅ 一致 |
| `xmp:Rating=-1` | `flag='reject'` | rating 裸扫 :71-81 取 `-1` 里第一个数字 → **`rating=1`**, flag 不变 | ❌ **宿主把 reject 读成 1 星** |
| `xmp:Rating=0` | `rating=0` | `rating=0` | ✅ 一致 |
| `xmp:Label=Green` | `label='green'` (色标, 不是旗标!) | `flag='pick'` (`:308`, `:381`) | ❌ **同名不同义**: 客体把 Label 当**色标**, 宿主当 **pick 旗标** |
| `xmp:Label=Red` | `label='red'` | `flag='reject'` | ❌ 同上的反向; 见 §6 唯一映射表 |
| `xmp:Label=Blue/Purple/Yellow` | `label='blue'/…` | `flag='none'` (:311 `_ =>`) | ⚠️ 客体的色标信息在宿主完全丢失 |
| `xmp:Label=红色` | `label='red'` (i18n `_LABEL_NAMES` :39-44) | `'none'` (精确匹配 "Red") | ❌ 宿主不支持多语言标签 |
| 无 `xmp:Label` | `label=''` | `'none'` | ✅ 等价 |
| 照片内嵌 XMP (无侧边栏) | ✅ 读 (`catalog.py:384-385`) | ❌ 只读侧边栏 (`xmp.rs:64-67`) | ⚠️ 宿主缺一条读路径 |

### 2.4 读取性能与并发形态

| | 宿主 | 客体 |
|---|---|---|
| 单文件读 | `fs::read_to_string` 全文 + 11 次 `find` (`xmp.rs:67-94`) | ExifTool 子进程, 200 张/批 |
| 扫描时 | `scan_folders` 同步串行 (`scanner.rs:236-514`), 1000 张 = 1000 次全文读 + 11×1000 次子串搜索 + `read_exif_metadata` | 常驻 GUI 懒读, CLI 批量 |
| 线程 | 同步 (调用方在 `spawn_blocking`) | 读在 `threading.Thread(name='xmp-read')` (`rating.py:401`), 写在 `xmp-write` 线程 (:423) |

---

## 3. 评级真值 vs 交换格式

### 3.1 宿主: 评级实际只活在 XMP 里

`db.rs:17-36` 只有两张表: `settings(key,value)` 与 `sessions(jpg_folder, raw_folder, last_index, sort_order, updated_at)`。**没有任何评级/旗标表**。因此:

- 真值 = 磁盘上的 `<stem>.xmp`。删/移侧边栏 = 评级永久丢失。
- 重启/切文件夹后, 评级必须重新扫盘重建 (`scanner.rs:306-315`, `:380-384`), 无缓存、无索引。
- `sessions` 只存"上次看到第几张", 不含任何评级状态 → **无增量同步的可能**。
- db 文件路径 `db.rs:150-161 get_db_path()`: CWD 下 `gallery_culling.db`, 失败退 `%TEMP%` (Tauri 下即安装目录, 随版本升级可能丢)。

### 3.2 客体: 追加日志是真值, XMP 只是交换格式

| 机制 | 函数(:行) | 细节 |
|---|---|---|
| 追加写 | `catalog.py:181-193 _append` | `ab+` 追加, `flush()` + **`os.fsync`** (:192) → 崩溃不丢评级 |
| 撕裂容忍 | `catalog.py:137-155 _read` | `rfind(b'\n')+1` 截掉写坏的最后一行; `_append` 会先探测末尾是否缺 `\n` 并补 (:186-189) |
| 重建状态 | `catalog.py:124-135 _apply` | 逐行重放; `validate` (:84-104) 过滤非法值 |
| 压缩 | `catalog.py:195-209 compact` | 每键一行原子重写 (`os.replace`); 触发条件 `_load` :162: `_lines >= 2000 and _lines > 4 × max(1, 键数)` |
| 跨进程读 | `catalog.py:165-179 refresh` | 检测 size < offset (被别人压缩过) → 全量 reload; CLI/MCP 与 GUI 共享同文件 (`:6-8` docstring) |
| 查询语言 | `catalog.py:269-336` | `_FIELD` 正则 (:269) + `parse_query` (:272-305) + `matches` (:313-336): `rating>=3 label:red flag:pick name:DSC0* -flag:reject edited folder:xxx`, 含 `★`/`picked`/颜色名等 shorthand (:295-304) |
| 时间戳 | `catalog.py:234` | 每条记录带 `t=round(time.time(),3)` → **真值带时间**, 这正是宿主缺的冲突裁决依据 |
| 上限 | `commands.py:248-249` | `library_add` 拒绝 > 2000; 选片集同限 (`library.py:361`); import 同限 (`commands.py:321`) |
| 自动写真 | `catalog.py:244-245` | 仅当 setting `library_xmp='1'` (:49-55) 且 `LUMEN_CATALOG` 未设 (:53) |

### 3.3 结论: 两侧的"权威源"错位

```
宿主:  [XMP 侧边栏] ←→  UI (中间无日志, 无时间戳)
客体:  [catalog.jsonl 真值, 带 t]  →(可选)→  [XMP 侧边栏 交换格式]
```

→ 宿主侧的评级**没有时间戳**, 无法参与 last-writer 裁决; 只能拿侧边栏 `mtime` 当代理 (§4.4)。这就是 §4.3 游标表必须存在的原因。

---

## 4. 双向同步落地方案

### 4.0 总架构

```
宿主 (Rust)                                    客体 (lumen-cli.exe sidecar)
─────────────                                  ───────────────────────
update_rating_flag_cmd ──► xmp.rs(合并写) ──►  <stem>.xmp  ◄── ExifTool 合并写
        │                                        ▲
        │ lumen_bridge.rs                        │
        ├─► lumen-cli run library.rate/flag/label ┘ (catalog.jsonl, 带 t)
        │      (仅当"评级来源不是 lumen 本身"时才推, 避免回声)
        │
scan_folders ──► read_xmp_full ──► PhotoGroupInfo.rating/flag
        ▲
        └─ db.rating_sync (游标表, §4.3)
```

**核心原则**: XMP 是两侧唯一的交换格式, 所以**宿主永远是"扫描侧边栏 → 对比游标 → 决定推/拉"**, lumen 只通过 CLI 被推或被查。

### 4.1 export (宿主 → 客体)

**触发时机**: 与宿主现有写真同步点重合 = `commands.rs:40-55 update_rating_flag_cmd` 内部 (`sync_xmp=true` 时)。**不要**新建独立同步按钮先做这个 —— 用户按星级的瞬间就该落到 lumen, 否则 lumen 打开看到旧值。

具体做法 (在 `update_rating_flag_cmd` 内, `write_xmp` 成功后):

```
if sync_xmp:
    xmp::write_xmp(path, rating, flag)?          # 宿主自己的合并写 (修完 §5 之后)
    lumen_bridge::push_rating(path, rating, flag) # 异步入队, 失败仅 log
```

`push_rating` 落点选择:

| 方案 | 命令 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| A 逐张 | `lumen-cli run library.rate {"rating":3,"paths":[p]}` (`commands.py:274-277`) |  semantics 与 GUI 完全一致, catalog.jsonl 天然带 `t`; 一条命令同时处理 rating/flag/label | 每次 spawn 0.5–1.5s (见 `.plan/research/D-packaging-comparison.md`) | ✅ **按 200ms 去抖合并成批**: 快捷键连按 5 次 = 1 次 spawn, 传 5 个 path |
| B 逐张 flag | `lumen-cli run library.flag {"flag":"pick","paths":[p]}` (`commands.py:281-283`) | 同上 | 同上 | ✅ 同上批处理 |
| C 批量写真 | `lumen-cli run library.write_xmp {"paths":[...]}` (`commands.py:301-306`) | 一次 ExifTool `-@` 批写 | 只写真**不看 catalog** → 若 lumen 侧 `library_xmp` 设置关着, catalog 仍旧; 且会**覆盖 lumen 刚写的 label** | ❌ 不用作主路径, 仅作" lumen 端补写真"的兜底 |

**去抖批处理设计** (`lumen_bridge.rs`):

```rust
struct RatingQueue {
    pending: Mutex<HashMap<PathBuf, (u8, String)>>, // 归一化后的 (rating, flag)
}
impl RatingQueue {
    fn push(&self, path: PathBuf, rating: u8, flag: String);   // 插入/覆盖 pending
    fn flush(&self) -> Result<(), String> {                     // spawn lumen-cli run library.rate/flag
        let batch = std::mem::take(&mut *self.pending.lock());
        // 按 flag 分组: rating 组 1 次 spawn, flag 组 1 次 spawn
    }
}
```
调用点: `update_rating_flag_cmd` (`commands.rs:49`) 里 push + `flush()`; 去抖由前端的 `useDebouncedCallback` (已有模式) 或 Rust 侧 200ms timer 承担。

**验收**: 宿主按 `3` 星 + `P` → 打开 LUMEN RAW → `lumen-cli list` 显示 rating=3 flag=pick; `catalog.jsonl` 末尾有两条带 `t` 的记录。

### 4.2 import (客体 → 宿主)

**触发时机**: `scan_folders` (`scanner.rs:236`) 之后 + 用户点"刷新"时。**不要**在每次按键时反拉 (lumen 可能没开, spawn 太贵)。

数据流: lumen 的真值在 catalog.jsonl, 不在侧边栏。所以宿主要拿 lumen 的评级, 有两条路:

| 方案 | 命令 | 拿到的 | 代价 |
|---|---|---|---|
| A (推荐) | `lumen-cli run library.read_xmp {"paths":[...]}` **之后** `lumen-cli list folder:<dir>` (`commands.py:212-230`) | `lumen-cli list` 返回 `[{path,name,rating,flag,label}]` (headless 分支 `cli.py:183-187`) — **catalog 真值, 非侧边栏** | 每文件夹 1 次 spawn; 2000 张内 JSON < 1MB |
| B | `lumen-cli xmp read <photos>` (`cli.py:196-200`) | 只写真 → 若 lumen 用户没开 `library_xmp`, sidecar 是旧的 | ❌ 语义不对 |

**A 的完整步骤**:

```
1. lumen_bridge::list_ratings(jpg_folder) -> Vec<PhotoRating>   // `lumen-cli list folder:<dir>`
2. 对 scan_folders 的每个 group:
     let lumen = lumen_map.get(&group.base_name 或完整 path)     // lumen 用绝对路径 key
     let xmp   = (group.rating, group.flag)                      // 来自侧边栏 (§2)
     let final = resolve(xmp, lumen, &cursor)                    // §4.4 冲突裁决
```

注意 `library.list` 的 `limit` 默认 500 (`commands.py:216`) → 调用时显式传 `limit: 5000`。

### 4.3 增量: 游标表 (db.rs 必加)

宿主没有评级时间戳, 所以"增量"不能靠时间窗口, 只能**显式记账**。给 `db.rs:17-36` 的 `new()` 加第三张表:

```sql
CREATE TABLE IF NOT EXISTS rating_sync (
    photo_path   TEXT PRIMARY KEY,   -- 绝对路径, 与 lumen 的 key() (catalog.py:75-77 normcase) 对齐: Windows 下小写
    rating       INTEGER NOT NULL,
    flag         TEXT NOT NULL,      -- '' | 'pick' | 'reject'
    source       TEXT NOT NULL,      -- 'host' | 'lumen'  (最后一次被谁写)
    sidecar_mtime INTEGER NOT NULL,  -- 宿主写真时的 mtime (秒), 用于检测"外部改了侧边栏"
    synced_at    INTEGER NOT NULL
)
```

增量判定 (纯本地, 无 spawn):

```
for each sidecar in folder:
    cur = read_xmp_full(sidecar)
    row = SELECT * FROM rating_sync WHERE photo_path=?
    if row.is_none() || row.rating != cur.rating || row.flag != cur.flag:
        → 本地已变更, 需 push (export 侧)
    if row.sidecar_mtime != 侧边栏实际 mtime:
        → 外部(lumen/Lightroom)改过侧边栏, 需 pull (import 侧)
```

`mtime` 直接来自 `scanner.rs:211-217` 已有的 `metadata.modified()` 逻辑, 不新增 IO。

### 4.4 冲突: last-writer-mtime 具体比什么

宿主没有 `t`, 所以用**两个时间戳 + 一个来源位**:

| 字段 | 宿主侧 | 客体侧 | 可比性 |
|---|---|---|---|
| `sidecar_mtime` | `fs::metadata(sidecar).modified()` (`commands.rs` 无, `scanner.rs:212-216` 同款) | ExifTool 写完后同 | ✅ 双方都写真, 都有 mtime |
| `t` (epoch.ms) | ❌ 无 | `catalog.jsonl` 每条记录 (`catalog.py:234`) | 只能单向读 |

**裁决规则** (在 `lumen_bridge.rs` 一个函数里, 不散落):

```
last_writer(sidecar_mtime_host, lumen_record_t_from_list) = 较大者胜
```
但 `lumen-cli list` 返回的 photo 对象 (`cli.py:185` `dict(path, name, **m)`) **不含 `t`** (`m` 只有 rating/flag/label)。所以拿不到客体的时间戳 → 降级规则:

- **主规则 (可实现)**: 如果 `rating_sync.row.source == 'lumen'` 且侧边栏 mtime 未变 → **lumen 赢** (说明 lumen 改完并回写了侧边栏)。
- 如果侧边栏 mtime 变了 (谁都可以改它) 且 `row.source == 'host'` → **host 赢**。
- 真正 ambiguous (两边 mtime 都晚于 last synced_at): 返回冲突列表给前端让用户点, **绝不静默覆盖** (与 `integration_plan.md:159,176` 一致)。

**要拿到 `t` 做严格裁决**, 可直接读 catalog.jsonl (`lumen-cli` 的 `--headless` Session 用的就是默认路径 `data_folder()/catalog.jsonl`, `catalog.py:67-72`) —— 但这越界了; 更干净的是两条 P2 patch: 给 `library.list` 的返回加 `t` (`commands.py:229 _meta`), 一行改动。

### 4.5 2000 张上限: 按文件夹分块

关键事实 (§3.2): 2000 上限只挡 `library.add` (`commands.py:248-249`), 而**同步用的三个命令都不挡**:
- `library.rate/flag/label` → `_rate` (:265-271) → `_targets` (:165-167) 只 resolve 路径, 不要求在图库内;
- `library.read_xmp` / `write_xmp` → 同样只 `_targets`;
- CLI 的 `rate/flag/label/xmp` (`cli.py:188-203`) 直接 `Catalog()` 不建 library。

所以:

| 操作 | 上限 | 分块策略 |
|---|---|---|
| export 推评级 | **无上限** | 一次 flush 全量传 paths (数组); 但命令行长度有限 → 按 500 路径/次切开 (Windows CreateProcess ~32KB 限制, 500×80 字节 ≈ 40KB, 取 400 保守) |
| import 拉评级 | **无上限** | `library.list` 的 `limit` 上限 5000 (`commands.py:216`) → 传 `limit:5000`; 若文件夹 > 5000 张, 按 `folder:<子目录>` 或 `name:` 前缀二次查 |
| 若未来要走 `library.add` (例如导入 .lumenalbum) | 2000 | 严格按文件夹分块, 每块 ≤ 2000 - 已在库数; 且**同步路径永不调 `library.add`** |

**按文件夹分块的实现**: 宿主已有 `jpg_folder`/`raw_folder` 概念 (`scanner.rs:241-266`), 天然分块单位。`scan_folders` 返回的 groups 已按文件夹组织; 每次同步的 paths 全部来自 `jpg_folder` (或 raw_folder) 下的一次扫描, 物理上不可能超 2000 单次同步目标 —— 而且 2000 限制本来就不在同步路径上。

---

## 5. xmp.rs 合并修复设计

### 5.1 两方案对比

| 维度 | ① roxmltree DOM 合并 (宿主内) | ② 委托 `lumen-cli run xmp write` (ExifTool) |
|---|---|---|
| 改动位置 | `xmp.rs` 单文件 + `Cargo.toml` 加 `roxmltree = "0.19"` | `xmp.rs:209-219 write_xmp` 改分支 + spawn 逻辑 |
| 未知 ns 保留 | 由代码显式遍历保留 (:188-193 模板只声明 4 个 ns, 其余 rdf:Description 节点**遍历拷贝**) | ExifTool 语义保证 |
| Lightroom 兼容 | 需自己保证 (§5.3 不变量) | ExifTool 保证 |
| 依赖 | lumen-cli **不存在**也能写真 (核心选片流不依赖 sidecar 存活) | **lumen-cli 缺失时 → 宿主完全不能写真** → 选片应用核心功能挂掉 |
| 性能 | 内存 DOM, 无子进程 | 每张 1 次 spawn (0.5–1.5s) → 批量评级不可接受 |
| `xmp:Rating=-1` 语义 | 自己写, 自己读, 闭环 | 依赖 `catalog.py:425` 的约定, 一旦客体改规则宿主跟着歪 |
| 原子性 | 可做 temp + `os.replace` | ExifTool `-overwrite_original` 已自带 |
| 调色参数 (`crs:`) | 宿主自己的 6 个字段继续自己写 | ExifTool 只写 rating/label → **crs 块得宿主另外保留, 还是要写 DOM** |
| 测试 | 纯 Rust 单测, CI 秒级 | 要真跑 exiftool 二进制 |
| 风险 | roxmltree 学一次 API; 序列化要手动保格式 | **lumen-cli 是 P1 交付物, P0 期间不存在**; 且 `integration_plan.md:18` 明写"修 xmp.rs 整文件覆盖缺陷"是前置 |

### 5.2 推荐: **方案 ① roxmltree DOM 合并**, 理由

1. **`integration_plan.md:133` 的闸门判定本身正确**, 且 D 报告已确认 lumen-cli 是 P0/P1 才出货的 sidecar — 让宿主核心写路径依赖一个可能不存在的 exe 是架构倒置。
2. 宿主必须自己写 `crs:` 6 项调色 → 无论如何都要保留"读旧 DOM → 改自己的块 → 写回"的能力, 委托方案省不掉这段代码。
3. 评级闭环 (写 `Rating=-1` / 读 `=-1`) 应在宿主自己有单测覆盖, 不依赖客体行为。
4. roxmltree 是纯 Rust 零依赖解析器, 不比现有依赖树更重。

**但保留一条委托后路**: `xmp.rs` 内部加 `fn write_xmp_merged(image, meta, prefer_exiftool: bool)`, 当 `lumen-cli` 存在且用户开启"用 ExifTool 写真"设置时走 ②, 否则走 ①。默认 ①。

### 5.3 方案 ① 伪代码级步骤

```rust
// 替换 xmp.rs:118-206 write_xmp_full 的主体
fn merge_xmp(existing: &str, meta: &XmpMetadata) -> String {
    // ours = 本方命名空间集合, 来自模板 :190-193
    const OURS: &[&str] = &[
        "http://ns.adobe.com/xap/1.0/",                  // xmp:Rating / xmp:Label
        "http://ns.adobe.com/exif/1.0/aux/",             // aux:Lens / aux:LensModel
        "http://ns.adobe.com/exif/1.0/",                 // exif:FocalLength / FNumber
        "http://ns.adobe.com/camera-raw-settings/1.0/",  // crs:*
    ];

    let doc = roxmltree::ParsingOptions::default()
        .parse(existing)                       // 解析失败 → fallback 到今天的模板 (向后兼容)
        .unwrap_or_else(|_| fresh_document(meta));   // fresh_document = 现有 :185-201 的 format!

    let rdf = doc.descendants().find(|n| n.tag_name().name() == "RDF").unwrap();

    // 1) 删除所有属于 OURS 的 rdf:Description 子节点 (整块连 xmlns 声明一起)
    //    注意: 客体/Lightroom 的标签落在*别的* Description 节点上, 不会被碰
    for desc in rdf.children().filter(|n| n.is_element() && is_ours(n, OURS)).collect::<Vec<_>>() {
        rdf.remove_child(desc);               // 或标记后重建
    }

    // 2) 构造本方的 rdf:Description, 按现有 :189-196 的顺序写属性
    let ours = build_description(meta);       // 复用 :122-183 的 *_tag 逻辑, 但产出节点而非字符串

    // 3) 插到 RDF 第一个子节点位置 (保持 Lightroom 读到的属性顺序稳定)
    rdf.insert_child(0, ours);

    // 4) 序列化: 保留 <?xpacket begin ...?> / <?xpacket end="w"?> 包裹  (:4, :186, :199)
    //    真要保持字节级兼容, 用"模板替换"而非通用序列化: 把新 Description 插回原串的
    //    :189-196 区间, 外围字节原样保留 → Lightroom 侧零差异 (见 5.4 不变量)
    render_into_xpacket(existing, ours)
}
```

**为什么第 4 步用"模板替换"而不是 `roxmltree` 的 `to_string`**: roxmltree 无写回 API (它只读), 且通用序列化会重排属性、丢 XML 声明、改缩进, 反而破坏向后兼容。稳妥做法:

```
保留 <?xpacket ...?> 与 </x:xmpmeta> 之间的原文;
在原 rdf:Description 区间 [:189 起, 到 :196 </rdf:Description>] 原地替换成本方节点文本;
若原文没有 rdf:Description (空/新文件) → 整份用现有 :185-201 模板。
```

这样字节级行为与今天**完全一致**当且仅当原文由本方模板写成 (本方案对此有断言测试), 而第三方标签落在其它 Description 节点 → 原样存活。

### 5.4 要动的函数/行号 (精确清单)

| # | 文件:函数:行 | 动作 |
|---|---|---|
| 1 | `src-tauri/Cargo.toml` :27-37 | 加 `roxmltree = "0.19"` (纯 Rust, 无原生依赖) |
| 2 | `xmp.rs:37-60 extract_tag_value` | 删裸字符串解析; 新 `fn xpath_value(doc, ns, local) -> Option<String>` 走 DOM |
| 3 | `xmp.rs:63-109 read_xmp_full` | 改用 DOM; **关键修复 :71-81** rating 解析改成 `let r: i32 = value.parse()?; rating = r.clamp(-1,5)`, 并新增 `rejected: bool` 字段到 `XmpMetadata` (:6-19) |
| 4 | `xmp.rs:118-206 write_xmp_full` | 主体改为 `merge_xmp(&existing, meta)`; 保留 `:185-201` 的 `format!` 模板作 `fresh_document` (无旧文件/解析失败时) |
| 5 | `xmp.rs:209-219 write_xmp` | reject 分支改为同时写 `xmp:Rating=-1` **并清空 `xmp:Label`** (现有只写 Label=Red, 与客体约定不一致, 见 §6) |
| 6 | `scanner.rs:306-315` + `:380-384` | label→flag 映射三处**统一**抽到 `xmp.rs` 的 `fn flag_from_xmp(label, rejected) -> String`, 且 `rejected` 参与判定 (宿主现在读不到 -1) |
| 7 | `commands.rs:202-209` 导出拷贝 | 不变 (侧边栏已含全部信息) |
| 8 | `db.rs:17-36` | 新增 `rating_sync` 表 (§4.3) |
| 9 | `src-tauri/src/lumen_bridge.rs` | 新建 (export/import/冲突, §4) |

### 5.5 模板不变量 (向后兼容 Lightroom, 逐字节断言)

| 不变量 | 源码位置 | 测试断言 |
|---|---|---|
| `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>` | `xmp.rs:4, :186` | 新文件以该 UUID 开头 |
| `x:xmptk="GalleryCulling"` | `xmp.rs:187` | 保留 |
| 4 个 xmlns 声明顺序 xmp→aux→exif→crs | `xmp.rs:190-193` | 按序出现 |
| `<rdf:Description rdf:about="">` 第一个子节点 | `xmp.rs:189` | 本方节点在 index 0 |
| `<?xpacket end="w"?>` | `xmp.rs:199` | 结尾一致 |
| `xmp:Rating` 紧随 Description | `xmp.rs:194` | Lightroom 靠 tag 名不靠顺序, 但仍保持 |

---

## 6. 评级映射表 (唯一映射表)

**唯一实现处建议**: `xmp.rs` 新增 `fn xmp_fields(rating: u8, flag: &str) -> (String /*label*/, i32 /*rating*/)`, 由 `write_xmp` (:209-219) 与 `lumen_bridge.rs` 共用; 读取侧 `fn flag_from_xmp(label: &str, rating: i32) -> (u8, String)`。禁止在 `scanner.rs` / `commands.rs` / 前端再出现第二份映射 (现状: `scanner.rs:307-311` 与 `:380-384` **已有两份重复映射**, 修时必须合一)。

### 6.1 写方向 (宿主 UI → XMP)

| 宿主 UI 状态 | `xmp:Rating` | `xmp:Label` | 客体读回 (`_fields_from_tags` :366-377) | Lightroom 读回 |
|---|---|---|---|---|
| rating 0, flag none | 0 | (清空) | rating=0, label='' | 无星无色 |
| rating 3, flag none | 3 | (清空) | rating=3, label='' | 3 星无色 |
| rating 3, flag **pick** | 3 | `Green` | rating=3, label='green' | 3 星 + 绿色色标 |
| rating 3, flag **reject** | **-1** | (清空) | flag='reject' (:370-372) | 排除 (LR 的 -1 惯例) |
| rating 0, flag pick | 0 | `Green` | rating=0, label='green' | 无色标有绿色 |
| rating 5, flag reject | **-1** | (清空) | flag='reject', rating 0 | 排除 |

### 6.2 读方向 (XMP → 宿主 UI)

| XMP | 宿主 rating | 宿主 flag | 备注 |
|---|---|---|---|
| `<Rating>5</Rating>` | 5 | none | |
| `<Rating>-1</Rating>` | **0** | **reject** | ⚠️ 必须修 `xmp.rs:71-81` 才拿得到 |
| `<Rating>-1</Rating>` + `<Label>Red</Label>` (旧宿主写的) | 0 | reject | 兼容旧文件 |
| `<Label>Green</Label>` | 0 | pick | 宿主既有约定 (:308) 保留 |
| `<Label>Red</Label>` (无 -1) | 0 | reject | 宿主既有约定 (:309) 保留 |
| `<Label>Blue/Purple/Yellow</Label>` | 0 | none | 信息丢弃 — **接受**, 宿主无常色概念; 但侧边栏里必须原样保留 (§5 合并) |
| `Label` 为中文/其它语言 | 0 | none | 同上; 若要支持 → 借 `catalog.py:58-64 label_from_text` 的别名表 |

### 6.3 边界

| 边界 | 规则 |
|---|---|
| rating 0 | **合法值, 不是"未评级"**。宿主 `meta.rating = 0u8` 默认 (:70) 与"真的 0 星"不可区分 → 这是 §4.3 游标表存在的原因之一; 修完后 `rating_sync.rating=0` + `synced_at` 即可区分"同步过的 0"和"从没同步过" |
| reject 与 rating 同时存在 | Rating=-1 优先 (LR 惯例); 宿主 UI 的 rating 显示 0 |
| 多次取消 (pick→none→pick) | 每次都写真, 无累计状态; 侧边栏只有终值 → 无历史可丢 |
| 同族双写 (RAW+JPG 都有侧边栏) | 宿主写真只写 RAW (`App.tsx:433`) → 宿主读也 RAW 优先 (`scanner.rs:373-387`) → 自洽; 但 lumen/LR 若写真到 JPG, 宿主**看不到** (现有设计, 不扩大范围) |
| 前端连续按 5 次星级 | 5 次 `write_xmp` + 5 次 spawn → 去抖合并成 1 次 (§4.1) |
| lumen 侧 rating=0 | `Catalog.set(paths, rating=0)` 有效, 但 `compact()` (:198-199) 过滤掉全零 entry → **0 星在日志里会被压掉** → 宿主不能把 0 星当真值同步回 lumen (会"消失") → **规则: rating=0 只写真, 不推 lumen** |
| 客体色标 vs 宿主 pick | **刻意不一致**: 客体 `label='green'` 是色标, 宿主 `flag='pick'` 是旗标, 但 XMP 里都是 `xmp:Label=Green`。→ 若用户先在 LR 打绿色色标, 宿主会显示 pick。**接受** (宿主就是这么约定的), 在 §8 步 7 有测试固化 |

---

## 7. Lightroom 目录导入是否移植到宿主

### 7.1 客体现状

`catalog.py:445-487 read_lightroom(path)`:
- 只读 `.lrcat` SQLite (`mode=ro` URI :452), Lightroom 占用时先 `shutil.copy2` 到临时目录 (:454-457);
- 查询 `Adobe_images × AgLibraryFile × AgLibraryFolder × AgLibraryRootFolder`, 首选 `image.masterImage IS NULL` 跳过虚拟拷贝 (:465), 失败降级不带该条件 (:467);
- 映射: `rating` clamp 0..5 (:477), `pick` 1→pick / -1→reject (:478-481), `colorLabels` → `label_from_text` (:482-484);
- 入口 `commands.py:309-322 library.import_lightroom` (`add` 参数才加进图库, 仍受 2000 限), GUI `rating.py:432-434`, CLI `cli.py:151-152, 204-206`。

### 7.2 移植判断

| 维度 | 评估 |
|---|---|
| 必要性 | **中**。宿主的价值主张是"选片后交给 LR/PS" (`tauri_architecture_plan.md:21, 173-178`), 反向导入不是核心路径; 用户若已有 LR catalog, 更可能直接 `lumen-cli import-lightroom` 再让宿主从侧边栏读 |
| 实现成本 | **低** (纯 SQL + 映射, ~60 行 Rust, rusqlite 已在 `db.rs:2` 依赖里) |
| 复用性 | **高**: §6 映射表 + §5 修复后的读路径直接把 `.lrcat` 的价值变成侧边栏值 |
| 风险 | LR schema 版本差异 (客体已用 try/except 兜底 :464-467); `.lrcat` 可达性 (路径来自 LR 内部 root 表, 可能是 UNC/离线盘) |

### 7.3 结论与建议

**不建议在 P1 移植到宿主, 走"借道"**:

```
宿主 UI「导入 Lightroom 评级」按钮
   → lumen_bridge::import_lightroom(lrcat_path)
        → lumen-cli run library.import_lightroom {"catalog": path}
             (客体写 catalog.jsonl, 此时若用户开了 library_xmp 会写真)
   → lumen_bridge::list_ratings(jpg_folder)   (§4.2)
   → 宿主 merge 进 scan_folders 结果 + rating_sync 记账
```

理由:
1. **一份实现**: LR 的 `pick=-1` / `colorLabels` 多语言解析 (`catalog.py:482 label_from_text` 支持 11 语言) 已在客体验证过, 移植=复制 + 必然漂移;
2. **1000+ 张时**: 借道路线只需 2 次 spawn, 移植路线要在宿主里重写 LR 的 SQL + 虚拟拷贝过滤 + 占用检测;
3. **与 §4 冲突裁决一致**: imported 值经 `rating_sync` 记账后, 宿主/lumen 两侧对同一个 `.lrcat` 的解读天然一致。

**唯一要做的宿主侧改动**: `commands.rs` 加 `import_lightroom_cmd(lrcat_path)` (10 行, 转发 + 触发一次 §4.2 的 pull)。若未来要脱离 lumen 单跑, 再把 `catalog.py:445-487` 逐行译成 Rust (映射逻辑已在 §6 表格里, 是机械翻译)。

---

## 8. step-by-step 落地步骤

每步独立可验证; 步 N 的验收标准不通过不得进 N+1。

| 步 | 动作 | 具体落点 | 验收标准 |
|---|---|---|---|
| **0** | **基线固化**: 写一份"整文件重写毁标签"的回归测试 (先红后绿) | `xmp.rs:263-337` tests 加 `test_write_does_not_destroy_foreign_tags` | `fn` 里手工构造含 `<lr:hierarchicalSubject>` / `<lumen:Recipe>` / `<dc:subject>` 的侧边栏 → 调 `write_xmp` → assert 三个标签仍存在。**当前必须红** |
| **1** | DOM 解析与"本方命名空间"判定 | `xmp.rs` 新 `fn ours_namespaces() -> &'static [&'static str]` (集合 = :190-193 那 4 个 URI) | 单测: 判定 Lightroom/ExifTool 生成的侧边栏 (各 ns 一个 `rdf:Description`) 全部 OURS=false; 本方的=true |
| **2** | DOM 读取替换裸字符串解析 | `xmp.rs:63-109 read_xmp_full` / `:37-60 extract_tag_value` → `fn tag(doc, ns, local)` | 单测: `Rating=-1` 返回 `rejected=true`; `Label=红色` 返回原文; `<tiff:ImageWidth>` 不会被误读成 focal (修掉 `find("exif:FocalLength")` 子串误匹配) |
| **3** | **合并写实现** | `xmp.rs:118-206 write_xmp_full` 主体 → `merge_xmp(existing, meta)`; 保留 :185-201 作 `fresh_document` | 步骤 0 的测试**转绿**; 附加断言: 无旧文件时输出与今天模板**逐字节一致** (把现有测试 `test_xmp_write_and_read` :267-280 的输出存 fixture 比对) |
| **4** | reject 语义统一 | `xmp.rs:209-219 write_xmp` 的 reject 分支: 写 `Rating=-1` + 清 `Label` | 单测: `write_xmp(p, 3, "reject")` → `catalog.py:366-377` 同款逻辑解析出 `flag=reject` (在 Rust 侧写等价断言) |
| **5** | 映射合一 | `scanner.rs:307-311` + `:380-384` 两处重复映射抽到 `xmp.rs::flag_from_xmp` | 单测参数化: 9 种 `(rating, label)` 组合 → 唯一 `(rating, flag)`; grep 确认 `scanner.rs` 无 `"Green" => "pick"` 字面量残留 |
| **6** | 游标表 | `db.rs:17-36` 加 `rating_sync` 表 + 4 个方法 (`upsert/lookup/mark_source/list_dirty`) | 单测: 临时 db → upsert → lookup → 改 flag → `list_dirty` 只返回 1 条; `sidecar_mtime` 变了也进 dirty |
| **7** | lumen 桥 + export | `src-tauri/src/lumen_bridge.rs` + `commands.rs` 的 `update_rating_flag_cmd` 内 push | 手工端到端: 宿主按 `4` 星 + `P` → `python main.py --cli list folder:<dir>` 显示 rating=4 flag=pick; 侧边栏里 `<lr:hierarchicalSubject>` 仍在 |
| **8** | lumen 桥 + import | `lumen_bridge::list_ratings(dir)` + `scan_folders` 后的 merge + `rating_sync` 记账 | 在 lumen 里给 3 张打星 (catalog.jsonl, 不开 library_xmp) → 宿主点刷新 → 3 张卡片显示星级; 再点一次 → **0 次 spawn** (全命中游标) |
| **9** | 冲突与去抖 | `lumen_bridge::resolve_conflict` + `RatingQueue` (200ms) | 两侧同时改同一张: 宿主改后不推 → `resolve_conflict` 返回 `Conflict{host, lumen}`; UI 列出; 手工裁决后 `rating_sync.source` 更新为胜方 |
| **10** | 批量 + 上限 | 400 路径/批的 chunk + 2000 检查 (确认不在同步路径上) | 造 2500 张临时文件目录 → export 全量成功, 无 `CommandError('a library holds at most 2000 photos')`; 单批 spawn 数 ≈ 7 次 |
| **11** | LR 借道导入 (可选) | `commands.rs::import_lightroom_cmd` → `library.import_lightroom` + 一次 §4.2 pull | 找一个真 `.lrcat`(或 mock) → 返回 `imported=N`, 其中虚拟拷贝被跳过; 宿主卡片显示 LR 的星级 |
| **12** | **回归全绿门** | `cargo test` (+ 前端 `pnpm test`) | §5.5 五条模板不变量、§6 映射表、步 0 测试、`tests/test_v160.py:286` 同款 ExifTool round-trip 全绿 |

---

## 附: 本报告的取证清单

- 宿主读入: `xmp.rs` 全文 338 行, `scanner.rs` 全文 526 行, `db.rs` 全文 161 行, `commands.rs` 相关段, `src/App.tsx:425-471`, `src/services/api.ts:35-45`, `src-tauri/Cargo.toml`
- 客体读入: `catalog.py` 全文 487 行, `commands.py:140-330`, `cli.py:63-221`, `rating.py:280-434`, `library.py:60-199, 325-384`, `session.py:20-69`, `white_balance.py:11-27`
- 未修改任何源文件 (只读铁律)。
