# ADR-010：选片集 `.galleryalbum`（FR-10）

- 日期：2026-10-19
- 状态：已采纳
- 相关：报告 `docs/lumen-benchmark-2026-10-18.md` §5.9、FR-10
- 前置事实：LUMEN `library.py:323-380` 的 `.lumenalbum` 格式与边界

## 背景

「目录会话」（`db.rs` 的 `sessions` 表）记的是**上次看到哪**：一个目录、一个
断点。它解决不了婚礼/活动摄影师的真实流程 —— 两三张卡、几个目录导入，最后要
合成一个「精选集」交给修图师。会话没有跨目录的语义，选片集有。

这一项本身不难（一个 JSON 清单 + 逐个 stat），难的是**别把它做成第二套图库**：

- 存什么？只存路径，还是连评级/旗标/色标一起存？
- 打开时信文件里的快照，还是信磁盘上的 XMP？
- 打开要不要读 EXIF（关系到「点击即开」能不能成立）？
- 它和目录会话在界面上怎么区分，才不会互相污染？

## 决策

### 1. 格式：`application` + `version` 双校验，边界照抄 LUMEN

```json
{
  "application": "Gallery Culling album",
  "version": 1,
  "documents": [
    { "source": "wedding/DSC04339.ARW", "jpg": "wedding/DSC04339.JPG",
      "rating": 3, "flag": "pick", "label": "Red" }
  ]
}
```

- **双校验**：只看 `version` 会把别的 JSON 当选片集打开，然后报一堆「缺失
  2000 个文件」；只看 `application` 会在格式演进时读坏新版。
- **≤2000 张 / ≤128MB**：照抄 LUMEN 的边界，目的是「别拿它当图库」。超限直接
  拒绝写并说明原因，不截断 —— 静默截断会让用户以为整本都存了。
- **相对路径优先**（相对 album 文件所在目录），跨盘或不在子树下时退回绝对路径。
  这是「整本选片集连同照片一起搬到另一台机器」能成立的唯一办法。
- **原子写**：temp + rename，写一半断电不会毁掉上一份。

### 2. **不存 `tone`**（与报告原文的偏离）

报告 §5.9 的格式草稿里有 `tone?`。没有采纳，理由：

调色的唯一真值是 XMP（ADR-001/003）。在 album 里再存一份，两份就会不同步 ——
用户在选片集打开后调了色，album 里的 `tone` 还是旧的；下次从 album 打开，
界面显示旧调色，一按保存就把它写回 XMP，真实调色被覆盖且不可恢复。

这与「调色基线必须随打开返回」不矛盾：**基线来自 XMP，不来自 album**（见决策 5）。

### 3. 主路径 RAW 优先，**配对 JPG 单独记一条**

`source` 与 `utils/groupPath` 同序：RAW 优先。写 XMP、打开原片都走它。

但只存 `source` 会让重新打开时这一组**退化成 `RAW_ONLY`**：C2 规则规定「无
JPG 的 RAW 组不许回落 `.NEF` 资产 URL」，LUMEN 没启用时整屏黑框。用户在文件夹
视图里明明是彩色的，打开选片集变黑 —— 纯粹的回退。

JPG/RAW 分目录是本应用的常规摆放（`jpgFolder` 是独立设置），所以配对路径必须
单独给一条，**不能从前一条拼出来**。

### 4. 配对 JPG 只有**真的在磁盘上**才算数

`jpg_path` 与 `jpg_exists` 由后端保证一致（`resolve_documents` 里 `metadata`
成功且 `is_file()` 才填 `jpg_path`）。前端再判一次 `d.jpgPath && d.jpgExists`。

记着路径但文件已删时仍当 COMPLETE，会拿一个不存在的 JPG 去渲染 —— 破图比没有
更糟：没有 JPG 至少还能走 LUMEN 或显示「RAW only」，破图看起来像程序坏了。

`None` 的语义是「保存时这一组就没有 JPG」，不是「忘了记」。

### 5. 打开时用**磁盘状态**覆盖快照，缺失的保留快照

`apply_disk_state` 对存在的条目重读 XMP + `.gallerycull.json`：

```rust
e.rating = m.rating;
e.flag = cullstore::resolve_flag(m.rejected, xmp::legacy_flag_from_label(&m.label), entry);
e.label = m.label.clone();
e.tone = scanner::extract_tone_from_xmp(&m);
```

为什么不信 album 里的快照：本应用的评级/旗标/色标唯一真值是 XMP +
`.gallerycull.json`。显示旧快照会让界面和文件互相矛盾 —— 用户看到 3 星、XMP 里
是 1 星，接着改一次就把「3 星」当真写回去。

快照仍然有用：缺失的文件没有磁盘状态可读，保留快照才能报告「它原来是 3 星 /
已标保留」。报告里说这句话比什么都不说有用。

**调色基线必须一起带回来**：少了 `tone`，调色面板起点是全 0，用户点一次保存就
把真实 XMP 调色覆盖成 0。提取走 `scanner::extract_tone_from_xmp`，与扫描路径
**同源**，不另写一份。

按目录缓存 `cullstore`：2000 张散在几个目录时不会重复读同一个 JSON。

### 6. **不读 EXIF**（打开速度的决定性取舍）

实测（`real_album_open_smoke`，真实相册 156 张 24.2MP ARW）：

| 项 | 耗时 |
|---|---|
| 打开（无 EXIF，最终实现） | **33 ms（0.21 ms/张）** |
| `exif` crate 读 EXIF | 1468 ms（9.41/张） |
| 其中「整文件读取」 | 1444 ms（9.26/张） |
| 只 stat | 3.3 ms |

关键发现：**不是解析贵，是读文件贵**。`exif` crate 对 ARW 是整文件读取（24MP
约 25MB），9.4 ms/张几乎全是 IO。按此线性外推 2000 张 ≈ 19 秒，超出「点击即开」
两个数量级；带 EXIF 时 156 张就已经 1959 ms，被我自己的 `<1000ms` 断言打红。

选片集的验收标准是「相对路径 / 换机可开 / 缺失列出 / ≤2000 / 原子写」，不含
相机参数。所以：**不读**。

**代价必须在界面上说出来，不能静默**：底栏不显示 ISO/快门；查询语法里 `iso:800`
会安静返回 0 张，用户会以为自己没拍过。兜底是 `ThumbnailGrid` 的
`queryExifUnavailable`：查询用到 `EXIF_FIELDS`（iso/camera/lens/aperture/shutter/
focal）且当前集合一条 `exif` 都没有时，状态行显示琥珀色「相机参数未加载（选片集
不读 EXIF），iso / 快门等条件不会命中」。

顺序是 `错误 → 输入中 → EXIF 不可用 → 条件数`：语法错误最要紧，`iso:` 打到一半
的「输入中」也不该被这条提示盖掉。

### 7. 前端 id 用**归一化路径**，不用 baseName

选片集跨目录，`D:\cardA\DSC1.ARW` 与 `E:\cardB\DSC1.ARW` 是两张照片。扫描按
baseName 合并只因为它「只扫一个目录对」；这个前提在选片集里不成立。用
`normalizeFilePath(d.path)` 做 id。

### 8. 缺失只报告，**不清空当前视图**；打开失败更不动

- 打开成功但缺 3 张：换成能打开的那些，缺的进 `AlbumDialog` 的「缺失文件报告」
  （`aria-label="缺失文件报告"`，每条给文件名 + 「原 3★ 保留」）。
- 打开失败（文件坏了、不是选片集）：**一次打不开的选片集不该换一次数据丢失**。
  当前集合原样不动，只弹错误。

### 9. 保存范围写在按钮上；保存成功**不改 `path`**

按钮文案是「选片集（选中 5 张）」/「选片集（当前筛选 42 张）」，
`saveScope = selectedIds.size > 0 ? 'selected' : 'filtered'`。存错范围要重新选
一遍才知道，所以范围必须写在按钮上而不是藏在对话框里。

`saveCount === 0` 时按钮禁用并给 `role="status"` 说明原因（「当前筛选下没有照片」
/「未选中照片」），不是静默什么都不做。

保存成功后**不把界面标成「正在看选片集」**：用户此刻看的仍是原目录，改了会让
顶栏目录框与照片列表互相矛盾。`path` 只在**打开**时设置。

### 10. 选片集视图的三条隔离

1. **改排序走本地排序**（`sortAlbumGroups`），不能走 `handleSortOrderChange` ——
   那条会按当前目录重扫，等于把整本选片集冲掉。排序键与后端 `scanner` 的
   `sort_order` 分支对齐（时间升序 / 星级降序 / 文件名升序，同分按 baseName
   兜底，不改原数组）。
2. **不写目录会话**：`useSessionDebounce({ jpgFolder: album.path ? '' : jpgFolder })`。
   写进去的索引会在下次扫描那个目录时被当成用户的位置恢复，而它其实来自另一批
   照片。
3. **扫描后撤掉选片集身份**：`handleScanned` 是空依赖 `useCallback`，拿不到后声明
   的 `album`，用 `albumClearRef`（与 `selectedIndexRef` / `oneToOneRef` 同一模式）。

### 11. 互斥表新增 `album` 活动

`album` 与 scan / export / render / ai / batch-write / apply-tone / refresh 互斥，
与 `thumbnail` 放行。理由：打开会**整体替换集合**，与扫描是同一个竞态；还要读
一遍 XMP，与写盘/套用调色撞上会读到半截。`BLOCKED_BY`、`ACTIVITIES`、
`ACTIVITY_LABELS`（`album: '读写选片集'`）三处同步 —— FR-09 的对称性测试会强制
这一点。

### 12. 归一化留在前端边界，后端**原样存取**

`rating`/`flag`/`label` 一律原样读写：album 是用户手里的文件，可能被手改过。
非法旗标当 `none` 的归一化在 `utils/albumGroups.ts` 做，与 `cullstore` 同口径 ——
读侧做两套归一化只会让「谁说了算」变模糊。

### 13. 后端扩展名表只许一份

`scanner.rs` 新增 `pub(crate) fn is_raw_extension(ext)`（大小写不敏感、容忍前导
点），`album.rs::is_raw_path` 调它，不再抄常量。抄第二份的后果是加一种新 RAW
格式时漏改一处，`is_raw` 静默变 `false`，`source` 与 `jpg` 的角色互换。

## 真机验证（2026-10-19）

真实相册 `Pictures/Camera Roll/2026年9月12日-惠州西湖`（468 个文件 / 156 组
ARW+JPG，24.2MP）：

```
[real_album_open] 156 张 / 33 ms（0.21 ms/张）/ 缺失 0
```

命令：

```bash
GALLERY_REAL_ALBUM_DIR="C:/Users/VerNe/Pictures/Camera Roll/2026年9月12日-惠州西湖" \
  cargo test --lib real_album_open_smoke -- --ignored --nocapture
```

断言 `< 1000 ms`（留了 30 倍余量：CI 机器更慢，但「点击即开」的量级不能丢）。

## 测试

新增 46 例前端 + 20 例后端（另有 2 例 `--ignored` 真机冒烟）：

| 层 | 文件 | 数量 | 覆盖要点 |
|---|---|---|---|
| 格式层 | `album.rs` | 18 | 双校验（外来的 JSON / 版本不符）、≤2000 与 ≤128MB 边界、空选片集往返、全字段往返、相对/绝对路径选择、缺失不阻塞其余、**配对 JPG 跨目录往返**、配对被删报 absent、`is_raw` 跟随 scanner 表、`has_xmp` 留给命令层、原子写不留 tmp |
| 命令层 | `commands/albumcmds.rs` | 11 + 1 ignored | 保存→打开往返、空路径拒绝、相对路径拒绝（主路径与配对 JPG 各一条）、缺失保留快照、磁盘状态覆盖快照、`has_xmp` 来自磁盘、**重开保留 JPG 配对**、**调色基线来自 XMP**、外来文件报可读错误、真机冒烟 |
| 转换层 | `utils/albumGroups.ts` | 16 | COMPLETE 重建、RAW_ONLY 不造假 jpg、JPG_ONLY、缺失进 `missing` 不进集合、配对被删（含 `jpgExists=false` 兜底）、同名跨目录不合并、调色进 `tones`、旗标归一化、`hasXmp` 透传、`toAlbumItems` 三条、`sortAlbumGroups` 四条（含不改原数组） |
| 加载器 | `hooks/useAlbum.ts` | 13 | 互斥原因、空清单不弹对话框、取消静默、保存不改 `path`、打开失败不动集合、重入保护、报告生命周期 |
| 对话框 | `components/AlbumDialog.tsx` | 11 | 范围与张数写进按钮、0 张禁用并说明、缺失报告列表、收起只清报告、键盘可达 |
| 集成 | `App.album.test.tsx` | 4 | 打开后集合替换且顶栏标出来源、**选片集视图排序不重扫**（`scan_folders_cmd` 调用数不变）、扫描后身份撤销、`open_album_cmd` 收到对话框选中的路径 |
| 宫格提示 | `ThumbnailGrid.stateA11y.test.tsx` | 2 | EXIF 条件 + 无相机参数时提示、不涉及 EXIF 时不误报 |

**变异验证 8 处 8 抓**：

- 后端 4：`jpg_path/jpg_exists` 置空、`is_raw` 置 false、`has_xmp` 置 false →
  4 failed；还原后全绿。
- 转换层 3：`id` 换成 stem、去掉 `jpgExists` 判定、不写 `tones` → 3 failed。
- App 层 2：`handleSortChange` 直接转 `handleSortOrderChange` + 删
  `albumClearRef.current()` → 2 failed。
- 宫格提示 2：提示永不渲染 → 正向用例红；改成「有条件就提示」→ 反向用例红。

回归：`tsc --noEmit` 0 错；前端 `76 files / 747 passed`；Rust `294 passed /
5 ignored`；clippy 只剩 `export.rs` 两处既有的 `too many arguments (9/7)`。

## 代价与风险

1. **EXIF 条件在选片集里查不到**。`iso:800` 返回 0 张，靠提示说明原因。用户若真
   要在选片集里按相机参数筛，只能回文件夹视图。补的成本见「后续」。
2. **`tone` 不在 album 里**，所以选片集本身不携带调色。换一台机器、XMP 没跟过去
   时，选片集能打开、评级也在（快照），但调色是 0。这是「唯一真值」的必然代价，
   比存两份不同步安全。
3. **2000 张上限对婚礼偏紧**。一场婚礼 3000–6000 张很常见，用户得分批存。这是
   照抄 LUMEN 的边界换来的可预期性；真放宽要连同「别当图库」这条一起重新论证。
4. **整本重写，没有合并**。`save_album_impl` 直接覆盖整份文件。两处同时保存
   （比如两份选片集指向同一路径）会互相覆盖。有意的：合并语义（按路径取并集？
   取最新？）比整本重写复杂得多，而选片集是「一次性交付物」，不是协作文件。
5. **路径失效没有自愈**。相册改名/移动后，绝对路径的条目全部变缺失，只能重新
   存一次。相对路径缓解了「album 与照片一起搬」的情况，但要求 album 文件放在
   照片的祖先目录里。
6. **缺失条目的快照会过期**。报告里说「原 3 星」是保存那一刻的事实，文件找回后
   以磁盘为准；用户看到报告与找回后的实际值不同，属于预期。
7. **与目录会话概念重叠**。UI 上靠琥珀色芯片「选片集 xxx.galleryalbum N 张」区分，
   但用户仍可能困惑「为什么我关了再开，回来的是文件夹」。缓解是芯片常驻 + `title`
   给全路径；根治要等设置里能管「最近打开的选片集」，不在本轮范围。
8. **互斥粒度粗**。打开选片集期间不能扫描/导出，哪怕只读 2000 条 XMP 只需 0.4 秒。
   这是 FR-09 的既定风格（宁可挡住也不并发），不为此开特例。
9. **`has_xmp` 逐个 `is_file()`**。2000 张 = 2000 次 stat，实测在 33 ms 的量级里
   （stat 3.3 ms / 156 张）。没有优化空间也没有必要。

## 后续

要补 EXIF 的话，唯一可行的方向是**异步补齐**而不是打开时同步读：

1. 打开先返回（33 ms），底栏/查询用「参数未知」状态；
2. 后台低优先级任务逐张读 EXIF（9.4 ms/张，2000 张约 19 秒），走 `taskgate` 的
   独立活动；
3. 读到一批就刷新一次集合（`queryExifUnavailable` 随之变 false）。

不建议的方向：改用「只读文件头 N KB」的解析器。ARW 的 EXIF 在 TIFF 头之后，
理论上可以只读前几 MB，但要自己实现 TIFF IFD 遍历 —— 为省 19 秒引入一个自研
解析器，维护成本远高于异步补齐。
