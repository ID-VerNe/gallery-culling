# SPEC — Step 8：评级双向同步（游标表 + push/pull）

> old-coder Tier 2。**spec approval: not obtained (autonomous run)**。
> 前置：Step 7（`flag_from_xmp` + `Rating=-1` 语义统一）。
> 目标：宿主打星/旗标 → 同步进 LUMEN RAW（catalog.jsonl + XMP）；LUMEN RAW 里的评级 → 回流宿主。

## 1. 背景

宿主评级真值只在 XMP 侧边栏，**没有时间戳**，无法做增量同步也无法判冲突（子代理 C 报告 §3）。
lumen 侧真值是 `catalog.jsonl`（追加日志，每条带 `t` 时间戳）。

## 2. 行为规格

### B1 `rating_sync` 游标表（db.rs）
- 列：`photo_path TEXT PK` / `rating INTEGER` / `flag TEXT` / `source TEXT(host|lumen)` /
  `sidecar_mtime INTEGER` / `synced_at INTEGER`；
- 方法：`upsert_rating_sync`、`lookup_rating_sync`、`list_dirty(folder)`（值变或侧边栏 mtime 变）、
  `clear_rating_sync`；
- 旧库无此表 → `CREATE TABLE IF NOT EXISTS` 自动建，零迁移。

### B2 `push_rating`（宿主 → lumen）
- 在 `update_rating_flag_cmd` 写完 XMP 后调用：`lumen_bridge::push_rating(exe, path, rating, flag)`；
- 用 **B 通道**（`run_lumen("library.rate"|"library.flag")`），走 runtime 失败兜底；
- **rating=0 且 flag=none 不推**（lumen 的 `compact()` 会把全零条目压掉，推了会"消失"）；
- 失败只记日志，不回滚宿主 UI（乐观更新不回滚原则）；
- 成功后 upsert 游标：`source='host'`, `sidecar_mtime=当前侧边栏 mtime`。

### B3 `pull_ratings`（lumen → 宿主）
- `lumen-cli run library.list {"query":"folder:<dir>","limit":5000}`（catalog 真值，非侧边栏）；
- 与宿主侧边栏对比：若 lumen 值不同且游标 `source='lumen'` 或侧边栏 mtime 未变 → 采用 lumen 值并写回 XMP；
- 返回变更列表供前端提示。

### B4 冲突
- 两侧都改过（游标 source=host 且侧边栏 mtime 变了）→ 不自动覆盖，返回 conflict 列表由用户裁决。

## 3. 不变量

N1 既有 85+3+11 测试零回归；N2 无新 crate；N3 **lumen 未安装/未启用时同步逻辑零调用**（feature off 不发请求）；
N4 同步失败绝不影响宿主评级写入（主流程优先）；N5 rating=0 不推。

## 4. 测试清单

单元：`rating_sync_crud`、`list_dirty_detects_changes`、`push_skips_zero_rating`（纯判定函数）、
`conflict_detection_rules`。
E2E（真实 sidecar）：`e2e_rating_push_and_pull_roundtrip` —— 宿主写 XMP → push → lumen list 读回 → pull 回宿主。

## 5. Gauntlet

同前六层 + 变异 5：push 忽略 rating=0、list_dirry 不比 mtime、upsert 不更新 source、冲突判定反向、push 失败影响主流程。