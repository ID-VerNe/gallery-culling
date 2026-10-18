use crate::models::AppSettings;
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct Database {
    conn: std::sync::Arc<Mutex<Connection>>,
}

/// 设置键值对（纯函数，供 save/load 与单测共用）。
pub(crate) fn settings_pairs(settings: &AppSettings) -> Vec<(&'static str, String)> {
    vec![
        ("default_jpg_folder", settings.default_jpg_folder.clone()),
        ("default_raw_folder", settings.default_raw_folder.clone()),
        ("photoshop_path", settings.photoshop_path.clone()),
        ("thumbnail_width", settings.thumbnail_width.to_string()),
        ("sort_order", settings.sort_order.clone()),
        ("lumen_enabled", settings.lumen_enabled.to_string()),
        ("lumen_cli_path", settings.lumen_cli_path.clone()),
        (
            "lumen_grid_thumbnails",
            settings.lumen_grid_thumbnails.to_string(),
        ),
        ("lumen_expect_ai", settings.lumen_expect_ai.to_string()),
    ]
}

/// 把单个 (key, value) 应用回 AppSettings（纯函数，load 与单测共用）。
///
/// 旧库没有 lumen 两个键 → 保持默认（关闭/空路径），零迁移风险。
pub(crate) fn apply_setting(settings: &mut AppSettings, key: &str, value: &str) {
    match key {
        "default_jpg_folder" => settings.default_jpg_folder = value.to_string(),
        "default_raw_folder" => settings.default_raw_folder = value.to_string(),
        "photoshop_path" => settings.photoshop_path = value.to_string(),
        "thumbnail_width" => {
            if let Ok(w) = value.parse::<u32>() {
                settings.thumbnail_width = w;
            }
        }
        "sort_order" => settings.sort_order = value.to_string(),
        "lumen_enabled" => settings.lumen_enabled = value == "true",
        "lumen_cli_path" => settings.lumen_cli_path = value.to_string(),
        "lumen_grid_thumbnails" => settings.lumen_grid_thumbnails = value == "true",
        "lumen_expect_ai" => settings.lumen_expect_ai = value == "true",
        _ => {}
    }
}

/// 一次外部改动的检测游标（FR-08）。
///
/// 语义是「上次读这个侧边栏时，它长什么样」。刷新时先 stat 拿 mtime：
/// 与这里一致就**一个字节都不读**（10k 张的增量全靠这一条），不一致才读内容，
/// 再与这里的 `rating/flag/label` 比 —— 内容没变（外部只是重新保存了一次）就
/// 只更新 mtime，不打扰界面。
///
/// 它**不是**真值：真值是 XMP 本身。这里只是「我上次看到的样子」。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XmpCursor {
    pub sidecar_path: String,
    /// 毫秒级 mtime。用秒会在「同一秒内两次写」时漏掉改动。
    pub mtime_ms: i64,
    pub rating: u8,
    pub flag: String,
    pub label: String,
}

/// 一条尚未落盘的写入意图（FR-03）。
///
/// 只描述「用户做过什么、还没写进磁盘」，不参与任何读取判定。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingWrite {
    pub photo_path: String,
    pub rating: u8,
    pub flag: String,
    /// 色标（`""` = 无色标）。与 rating/flag 一起整组回放。
    pub label: String,
    /// 用户做这次改动的时间（Unix 秒）。回放时据此判断侧边栏是否被外部改过。
    pub updated_at: i64,
}

impl Clone for Database {
    fn clone(&self) -> Self {
        Self {
            conn: std::sync::Arc::clone(&self.conn),
        }
    }
}

impl Database {
    pub fn new() -> Result<Self, String> {
        Self::open(&get_db_path())
    }

    /// 打开指定路径的库。测试用独立临时库，避免污染用户真实的 `gallery_culling.db`。
    pub fn open(db_path: &Path) -> Result<Self, String> {
        let conn = Connection::open(db_path)
            .map_err(|e| format!("打开数据库失败 ({}): {}", db_path.display(), e))?;

        // Initialize tables
        conn.execute(
            "CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )",
            [],
        )
        .map_err(|e| format!("创建 settings 表失败: {}", e))?;

        // Rating sync cursor: host has no rating timestamps, so incremental sync and
        // conflict detection need explicit bookkeeping (glue report C §3).
        conn.execute(
            "CREATE TABLE IF NOT EXISTS rating_sync (
                photo_path    TEXT PRIMARY KEY,
                rating        INTEGER NOT NULL,
                flag          TEXT NOT NULL,
                source        TEXT NOT NULL,
                sidecar_mtime INTEGER NOT NULL,
                synced_at     INTEGER NOT NULL
            )",
            [],
        )
        .map_err(|e| format!("创建 rating_sync 表失败: {}", e))?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS sessions (
                jpg_folder TEXT PRIMARY KEY,
                raw_folder TEXT,
                last_index INTEGER,
                sort_order TEXT,
                updated_at INTEGER
            )",
            [],
        )
        .map_err(|e| format!("创建 sessions 表失败: {}", e))?;

        // 待写盘意图（FR-03）：评级先落这张表，再异步写 XMP。
        //
        // 它**不是**第二份真值 —— XMP / `.gallerycull.json` 才是。这里只记录
        // 「用户已经做过、但还没落盘」的意图，写成功即删；任何读路径都不读它。
        conn.execute(
            "CREATE TABLE IF NOT EXISTS pending_xmp (
                photo_path TEXT PRIMARY KEY,
                rating     INTEGER NOT NULL,
                flag       TEXT NOT NULL,
                label      TEXT NOT NULL DEFAULT '',
                updated_at INTEGER NOT NULL
            )",
            [],
        )
        .map_err(|e| format!("创建 pending_xmp 表失败: {}", e))?;

        // 旧库补列：`CREATE TABLE IF NOT EXISTS` 对已存在的表是空操作，不会补列。
        // 色标是后加的字段，升级用户的库里没有它 —— 显式检查后再 ALTER。
        ensure_column(&conn, "pending_xmp", "label", "TEXT NOT NULL DEFAULT ''")?;

        // XMP 增量游标（FR-08）：每个侧边栏一行，记录上次读到的 mtime 与三项状态。
        // 主键是**侧边栏路径**而不是照片路径：同一个 base_name 在 JPG / RAW 两侧
        // 可能各有一份 sidecar，两份的 mtime 各自独立变化。
        conn.execute(
            "CREATE TABLE IF NOT EXISTS xmp_cursor (
                sidecar_path TEXT PRIMARY KEY,
                mtime_ms     INTEGER NOT NULL,
                rating       INTEGER NOT NULL,
                flag         TEXT NOT NULL,
                label        TEXT NOT NULL DEFAULT '',
                seen_at      INTEGER NOT NULL
            )",
            [],
        )
        .map_err(|e| format!("创建 xmp_cursor 表失败: {}", e))?;

        Ok(Self {
            conn: std::sync::Arc::new(Mutex::new(conn)),
        })
    }

    pub fn load_settings(&self) -> Result<AppSettings, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut settings = AppSettings::default();

        let mut stmt = conn
            .prepare("SELECT key, value FROM settings")
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;

        for row in rows.flatten() {
            apply_setting(&mut settings, &row.0, &row.1);
        }

        Ok(settings)
    }

    pub fn save_settings(&self, settings: &AppSettings) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let pairs = settings_pairs(settings);

        for (k, v) in pairs {
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = ?2",
                params![k, v],
            )
            .map_err(|e| format!("保存设置 '{}' 失败: {}", k, e))?;
        }

        Ok(())
    }

    /// 记录一次评级同步（upsert 游标）。
    pub fn upsert_rating_sync(
        &self,
        photo_path: &str,
        rating: u8,
        flag: &str,
        source: &str,
        sidecar_mtime: i64,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let now = now_secs();
        conn.execute(
            "INSERT INTO rating_sync (photo_path, rating, flag, source, sidecar_mtime, synced_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(photo_path) DO UPDATE SET
                rating = ?2, flag = ?3, source = ?4, sidecar_mtime = ?5, synced_at = ?6",
            params![photo_path, rating as i64, flag, source, sidecar_mtime, now],
        )
        .map_err(|e| format!("记录评级同步失败: {}", e))?;
        Ok(())
    }

    /// 查询某张照片的同步游标。
    pub fn lookup_rating_sync(
        &self,
        photo_path: &str,
    ) -> Result<Option<(u8, String, String, i64)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT rating, flag, source, sidecar_mtime FROM rating_sync WHERE photo_path = ?1",
            )
            .map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query_map(params![photo_path], |row| {
                Ok((
                    row.get::<_, i64>(0)? as u8,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        Ok(rows.next().and_then(|r| r.ok()))
    }

    /// 清空同步游标（引擎关闭时）。
    pub fn clear_rating_sync(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM rating_sync", [])
            .map_err(|e| format!("清空评级同步失败: {}", e))?;
        Ok(())
    }

    /// 记下一次待写盘意图。同一张照片只保留最新一条。
    ///
    /// 调用方必须在**发起写盘之前**调用它：这一行是「用户确实改过」的唯一证据，
    /// 写盘失败或进程被杀时靠它回放。
    pub fn enqueue_pending(
        &self,
        photo_path: &str,
        rating: u8,
        flag: &str,
        label: &str,
        updated_at: i64,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO pending_xmp (photo_path, rating, flag, label, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(photo_path) DO UPDATE SET
                rating = ?2, flag = ?3, label = ?4, updated_at = ?5",
            params![photo_path, rating as i64, flag, label, updated_at],
        )
        .map_err(|e| format!("记录待写盘标记失败: {}", e))?;
        Ok(())
    }

    /// 读出全部待写盘意图（启动回放用）。
    pub fn list_pending(&self) -> Result<Vec<PendingWrite>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT photo_path, rating, flag, label, updated_at FROM pending_xmp")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(PendingWrite {
                    photo_path: row.get::<_, String>(0)?,
                    rating: row.get::<_, i64>(1)?.max(0) as u8,
                    flag: row.get::<_, String>(2)?,
                    label: row.get::<_, String>(3)?,
                    updated_at: row.get::<_, i64>(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        Ok(rows.flatten().collect())
    }

    /// 读出单张照片的待写盘意图（刷新时的冲突判定用）。
    ///
    /// 与 `list_pending` 分开：刷新一次要问 10k 次「这张有没有未同步意图」，
    /// 每次都全表扫一遍是不可接受的。
    pub fn lookup_pending(&self, photo_path: &str) -> Result<Option<PendingWrite>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT photo_path, rating, flag, label, updated_at
                 FROM pending_xmp WHERE photo_path = ?1",
            )
            .map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query_map(params![photo_path], |row| {
                Ok(PendingWrite {
                    photo_path: row.get::<_, String>(0)?,
                    rating: row.get::<_, i64>(1)?.max(0) as u8,
                    flag: row.get::<_, String>(2)?,
                    label: row.get::<_, String>(3)?,
                    updated_at: row.get::<_, i64>(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        Ok(rows.next().and_then(|r| r.ok()))
    }

    /// 落盘成功后删除意图。
    pub fn delete_pending(&self, photo_path: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM pending_xmp WHERE photo_path = ?1",
            params![photo_path],
        )
        .map_err(|e| format!("删除待写盘记录失败: {}", e))?;
        Ok(())
    }

    /// 待写盘条数（诊断与测试用）。
    pub fn count_pending(&self) -> Result<usize, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM pending_xmp", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        Ok(n.max(0) as usize)
    }

    /// 记下一次「我看到了什么」（FR-08）。同一侧边栏只保留最新一行。
    pub fn upsert_xmp_cursor(&self, cursor: &XmpCursor) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO xmp_cursor (sidecar_path, mtime_ms, rating, flag, label, seen_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(sidecar_path) DO UPDATE SET
                mtime_ms = ?2, rating = ?3, flag = ?4, label = ?5, seen_at = ?6",
            params![
                cursor.sidecar_path,
                cursor.mtime_ms,
                cursor.rating as i64,
                cursor.flag,
                cursor.label,
                now_secs()
            ],
        )
        .map_err(|e| format!("记录 XMP 游标失败: {}", e))?;
        Ok(())
    }

    /// 批量写游标（扫描收尾用）：**必须在一个事务里**。
    ///
    /// 逐条 `execute` 每次都会提交并 fsync，10k 张会让扫描收尾多花数秒 ——
    /// 这是「扫描完卡一下」的典型来源。
    pub fn upsert_xmp_cursors(&self, cursors: &[XmpCursor]) -> Result<(), String> {
        if cursors.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("开启游标事务失败: {}", e))?;
        let now = now_secs();
        for cursor in cursors {
            tx.execute(
                "INSERT INTO xmp_cursor (sidecar_path, mtime_ms, rating, flag, label, seen_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(sidecar_path) DO UPDATE SET
                    mtime_ms = ?2, rating = ?3, flag = ?4, label = ?5, seen_at = ?6",
                params![
                    cursor.sidecar_path,
                    cursor.mtime_ms,
                    cursor.rating as i64,
                    cursor.flag,
                    cursor.label,
                    now
                ],
            )
            .map_err(|e| format!("写入 XMP 游标失败（{}）: {}", cursor.sidecar_path, e))?;
        }
        tx.commit()
            .map_err(|e| format!("提交游标事务失败: {}", e))?;
        Ok(())
    }

    /// 查询某个侧边栏的游标。没有记录 = 从未读过它。
    pub fn lookup_xmp_cursor(&self, sidecar_path: &str) -> Result<Option<XmpCursor>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT sidecar_path, mtime_ms, rating, flag, label
                 FROM xmp_cursor WHERE sidecar_path = ?1",
            )
            .map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query_map(params![sidecar_path], |row| {
                Ok(XmpCursor {
                    sidecar_path: row.get::<_, String>(0)?,
                    mtime_ms: row.get::<_, i64>(1)?,
                    rating: row.get::<_, i64>(2)?.max(0) as u8,
                    flag: row.get::<_, String>(3)?,
                    label: row.get::<_, String>(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        Ok(rows.next().and_then(|r| r.ok()))
    }

    /// 侧边栏已消失时清掉游标：留着会让每次刷新都重复判一次「外部删除」。
    pub fn delete_xmp_cursor(&self, sidecar_path: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM xmp_cursor WHERE sidecar_path = ?1",
            params![sidecar_path],
        )
        .map_err(|e| format!("删除 XMP 游标失败: {}", e))?;
        Ok(())
    }

    pub fn save_session(
        &self,
        jpg_folder: &str,
        raw_folder: &str,
        last_index: usize,
        sort_order: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        conn.execute(
            "INSERT INTO sessions (jpg_folder, raw_folder, last_index, sort_order, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(jpg_folder) DO UPDATE SET
                raw_folder = ?2,
                last_index = ?3,
                sort_order = ?4,
                updated_at = ?5",
            params![
                jpg_folder,
                raw_folder,
                last_index as i64,
                sort_order,
                now as i64
            ],
        )
        .map_err(|e| format!("保存会话失败: {}", e))?;

        Ok(())
    }

    pub fn load_session(&self, jpg_folder: &str) -> Result<Option<(usize, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT last_index, sort_order FROM sessions WHERE jpg_folder = ?1")
            .map_err(|e| e.to_string())?;

        let mut rows = stmt.query(params![jpg_folder]).map_err(|e| e.to_string())?;

        if let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let last_index: i64 = row.get(0).unwrap_or(0);
            let sort_order: String = row.get(1).unwrap_or_else(|_| "time_filename".to_string());
            Ok(Some((last_index.max(0) as usize, sort_order)))
        } else {
            Ok(None)
        }
    }
}

/// 给已存在的表补一列（幂等）。
///
/// 只用于本模块内的**字面量**表名/列名 —— 不做任何转义，也不接受外部输入。
fn ensure_column(conn: &Connection, table: &str, column: &str, decl: &str) -> Result<(), String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({})", table))
        .map_err(|e| format!("读取表结构失败（{}）: {}", table, e))?;
    let exists = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("读取表结构失败（{}）: {}", table, e))?
        .flatten()
        .any(|name| name.eq_ignore_ascii_case(column));
    if exists {
        return Ok(());
    }
    conn.execute(
        &format!("ALTER TABLE {} ADD COLUMN {} {}", table, column, decl),
        [],
    )
    .map_err(|e| format!("为 {}.{} 补列失败: {}", table, column, e))?;
    Ok(())
}

fn get_db_path() -> PathBuf {
    let local = PathBuf::from("gallery_culling.db");
    // create(true) 配 write(true) 但**没有** truncate(true)：刻意如此 ——
    // 这里只是探测「当前目录可写」，绝不能把已存在的数据库清空。
    if std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&local)
        .is_ok()
    {
        local
    } else {
        std::env::temp_dir().join("gallery_culling.db")
    }
}

/// 当前 Unix 秒。写盘意图的时间戳与侧边栏 mtime 用同一把尺子。
pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn file_mtime_secs(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(-1)
}

/// 毫秒级 mtime（FR-08 的增量游标用）。
///
/// 秒级不够：同一秒内「外部写一次 → 我们刷新一次 → 外部再写一次」时，两次
/// mtime 会被截断成同一个值，第二次改动就被静默跳过了。
pub fn file_mtime_ms(path: &Path) -> Option<i64> {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个用例独立临时库：测试并行跑，共用一个文件会互相踩。
    fn temp_db(tag: &str) -> (Database, PathBuf) {
        let path = std::env::temp_dir().join(format!("gc_db_{}_{}.db", tag, std::process::id()));
        let _ = std::fs::remove_file(&path);
        (Database::open(&path).expect("建临时库"), path)
    }

    #[test]
    fn pending_upsert_keeps_latest_intent() {
        let (db, path) = temp_db("pending_upsert");
        db.enqueue_pending("C:/p/a.JPG", 3, "none", "Red", 100)
            .unwrap();
        // 同一张照片再改一次：只保留最新一条，不能堆成两行。
        // 色标也必须跟着覆盖 —— 否则回放会把红标写回一张已经改过标的照片。
        db.enqueue_pending("C:/p/a.JPG", 5, "pick", "Blue", 200)
            .unwrap();

        let rows = db.list_pending().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0],
            PendingWrite {
                photo_path: "C:/p/a.JPG".to_string(),
                rating: 5,
                flag: "pick".to_string(),
                label: "Blue".to_string(),
                updated_at: 200,
            }
        );

        let _ = std::fs::remove_file(&path);
    }

    /// 升级路径：色标之前创建的 `pending_xmp` 没有 label 列。
    /// `CREATE TABLE IF NOT EXISTS` 不会补列，必须靠 `ensure_column`。
    #[test]
    fn old_pending_table_gets_label_column() {
        let path = std::env::temp_dir().join(format!("gc_db_migrate_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            // 造一个"旧版本"的库：表结构与色标落地前一致
            let conn = Connection::open(&path).expect("建旧库");
            conn.execute(
                "CREATE TABLE pending_xmp (
                    photo_path TEXT PRIMARY KEY,
                    rating     INTEGER NOT NULL,
                    flag       TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                )",
                [],
            )
            .expect("旧表");
            conn.execute(
                "INSERT INTO pending_xmp VALUES ('C:/p/old.JPG', 4, 'pick', 7)",
                [],
            )
            .expect("旧行");
        }

        let db = Database::open(&path).expect("打开旧库应自动补列");
        let rows = db.list_pending().expect("旧行仍可读");
        assert_eq!(rows.len(), 1, "补列不得丢行");
        assert_eq!(rows[0].label, "", "旧行的色标按空处理");
        // 补列之后能正常写新值
        db.enqueue_pending("C:/p/new.JPG", 1, "none", "Green", 8)
            .expect("写新行");
        assert_eq!(db.count_pending().unwrap(), 2);

        drop(db);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn pending_roundtrip_and_delete() {
        let (db, path) = temp_db("pending_roundtrip");
        db.enqueue_pending("C:/p/a.JPG", 1, "reject", "", 10).unwrap();
        db.enqueue_pending("C:/p/b.JPG", 4, "pick", "", 20).unwrap();
        assert_eq!(db.count_pending().unwrap(), 2);

        db.delete_pending("C:/p/a.JPG").unwrap();
        let rows = db.list_pending().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].photo_path, "C:/p/b.JPG");

        // 删不存在的行不算错（回放可能重复删）
        db.delete_pending("C:/p/missing.JPG").unwrap();

        let _ = std::fs::remove_file(&path);
    }

    /// 意图必须活过进程重启：这是 FR-03「零丢失」的全部依据。
    #[test]
    fn pending_survives_reopen() {
        let (db, path) = temp_db("pending_reopen");
        db.enqueue_pending("C:/p/a.JPG", 2, "pick", "", 42).unwrap();
        drop(db);

        let reopened = Database::open(&path).expect("重开");
        let rows = reopened.list_pending().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].rating, 2);
        assert_eq!(rows[0].updated_at, 42);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn settings_pairs_contains_lumen_keys() {
        let mut s = AppSettings::default();
        let pairs = settings_pairs(&s);
        let map: std::collections::HashMap<&str, String> = pairs.into_iter().collect();
        assert_eq!(map.get("lumen_enabled").map(String::as_str), Some("false"));
        assert_eq!(map.get("lumen_cli_path").map(String::as_str), Some(""));
        // 宫格引擎开关：默认 false（EXIF 内嵌缩略图），必须与其它键一起落盘
        assert_eq!(
            map.get("lumen_grid_thumbnails").map(String::as_str),
            Some("false")
        );
        apply_setting(&mut s, "lumen_grid_thumbnails", "true");
        assert!(s.lumen_grid_thumbnails);
        // 既有 5 键不回归
        assert!(map.contains_key("photoshop_path"));
        assert!(map.contains_key("thumbnail_width"));
        assert_eq!(map.len(), 9);
    }

    #[test]
    fn apply_setting_lumen_roundtrip() {
        let mut s = AppSettings::default();
        assert!(!s.lumen_enabled);
        apply_setting(&mut s, "lumen_enabled", "true");
        assert!(s.lumen_enabled);
        apply_setting(&mut s, "lumen_enabled", "false");
        assert!(!s.lumen_enabled);
        apply_setting(&mut s, "lumen_cli_path", r"C:\lumen\lumen-cli.exe");
        assert_eq!(s.lumen_cli_path, r"C:\lumen\lumen-cli.exe");
    }

    #[test]
    fn apply_setting_existing_keys_unchanged() {
        let mut s = AppSettings::default();
        apply_setting(&mut s, "photoshop_path", r"C:\ps\PS.exe");
        apply_setting(&mut s, "thumbnail_width", "300");
        apply_setting(&mut s, "sort_order", "rating");
        assert_eq!(s.photoshop_path, r"C:\ps\PS.exe");
        assert_eq!(s.thumbnail_width, 300);
        assert_eq!(s.sort_order, "rating");
    }

    #[test]
    fn apply_setting_junk_values_tolerated() {
        let mut s = AppSettings::default();
        apply_setting(&mut s, "lumen_enabled", "yes"); // 非 true/false → 保持默认 false
        assert!(!s.lumen_enabled);
        apply_setting(&mut s, "thumbnail_width", "not-a-number");
        assert_eq!(s.thumbnail_width, 200); // 默认值不被污染
        apply_setting(&mut s, "unknown_future_key", "x"); // 未知键静默忽略
    }

    fn cursor(path: &str, mtime: i64, rating: u8, flag: &str, label: &str) -> XmpCursor {
        XmpCursor {
            sidecar_path: path.to_string(),
            mtime_ms: mtime,
            rating,
            flag: flag.to_string(),
            label: label.to_string(),
        }
    }

    /// 游标必须能被读回，且「同一侧边栏再写一次」只更新不新增。
    #[test]
    fn xmp_cursor_roundtrip_and_upsert() {
        let (db, path) = temp_db("cursor_roundtrip");
        db.upsert_xmp_cursor(&cursor("C:/p/a.xmp", 1000, 3, "pick", "Red"))
            .unwrap();

        let got = db
            .lookup_xmp_cursor("C:/p/a.xmp")
            .unwrap()
            .expect("应能读回");
        assert_eq!(got, cursor("C:/p/a.xmp", 1000, 3, "pick", "Red"));

        // 外部又改了一次：同一路径覆盖，不新增行
        db.upsert_xmp_cursor(&cursor("C:/p/a.xmp", 2000, 5, "none", ""))
            .unwrap();
        let got = db.lookup_xmp_cursor("C:/p/a.xmp").unwrap().unwrap();
        assert_eq!(got.mtime_ms, 2000, "mtime 必须跟着更新");
        assert_eq!(got.rating, 5);
        assert_eq!(got.flag, "none");

        // 没记录过 = None（不是空游标，调用方要能区分「从未读过」与「读过但空」）
        assert!(db.lookup_xmp_cursor("C:/p/missing.xmp").unwrap().is_none());

        let _ = std::fs::remove_file(&path);
    }

    /// 侧边栏消失后游标要能删掉，否则每次刷新都重判一次「外部删除」。
    #[test]
    fn xmp_cursor_delete() {
        let (db, path) = temp_db("cursor_delete");
        db.upsert_xmp_cursor(&cursor("C:/p/a.xmp", 1, 2, "none", ""))
            .unwrap();
        db.delete_xmp_cursor("C:/p/a.xmp").unwrap();
        assert!(db.lookup_xmp_cursor("C:/p/a.xmp").unwrap().is_none());
        // 删不存在的行不算错
        db.delete_xmp_cursor("C:/p/none.xmp").unwrap();
        let _ = std::fs::remove_file(&path);
    }

    /// 批量写（扫描收尾）：一次写多条，空批次是空操作。
    #[test]
    fn xmp_cursor_batch_upsert() {
        let (db, path) = temp_db("cursor_batch");
        db.upsert_xmp_cursors(&[]).expect("空批次应直接返回");

        db.upsert_xmp_cursors(&[
            cursor("C:/p/a.xmp", 10, 1, "none", ""),
            cursor("C:/p/b.xmp", 20, 2, "pick", "Blue"),
        ])
        .unwrap();

        assert_eq!(db.lookup_xmp_cursor("C:/p/a.xmp").unwrap().unwrap().rating, 1);
        let b = db.lookup_xmp_cursor("C:/p/b.xmp").unwrap().unwrap();
        assert_eq!(b.rating, 2);
        assert_eq!(b.label, "Blue");

        // 覆盖已有行而不是报主键冲突
        db.upsert_xmp_cursors(&[cursor("C:/p/a.xmp", 11, 4, "reject", "")])
            .unwrap();
        let a = db.lookup_xmp_cursor("C:/p/a.xmp").unwrap().unwrap();
        assert_eq!(a.mtime_ms, 11);
        assert_eq!(a.rating, 4);
        assert_eq!(a.flag, "reject");

        let _ = std::fs::remove_file(&path);
    }

    /// 单张查 pending：刷新时问 10k 次，不能每次全表扫。
    #[test]
    fn lookup_pending_returns_only_that_row() {
        let (db, path) = temp_db("pending_lookup");
        db.enqueue_pending("C:/p/a.JPG", 3, "pick", "Red", 100)
            .unwrap();
        db.enqueue_pending("C:/p/b.JPG", 5, "none", "", 200)
            .unwrap();

        let a = db.lookup_pending("C:/p/a.JPG").unwrap().expect("应有记录");
        assert_eq!(a.rating, 3);
        assert_eq!(a.flag, "pick");
        assert_eq!(a.label, "Red");
        assert_eq!(a.updated_at, 100);

        assert!(db.lookup_pending("C:/p/c.JPG").unwrap().is_none());

        let _ = std::fs::remove_file(&path);
    }
}
