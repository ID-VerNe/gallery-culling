use crate::models::AppSettings;
use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct Database {
    conn: Mutex<Connection>,
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
        _ => {}
    }
}

impl Database {
    pub fn new() -> Result<Self, String> {
        let db_path = get_db_path();
        let conn = Connection::open(&db_path)
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

        Ok(Self {
            conn: Mutex::new(conn),
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

fn get_db_path() -> PathBuf {
    let local = PathBuf::from("gallery_culling.db");
    if let Ok(_) = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(&local)
    {
        local
    } else {
        std::env::temp_dir().join("gallery_culling.db")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_pairs_contains_lumen_keys() {
        let s = AppSettings::default();
        let pairs = settings_pairs(&s);
        let map: std::collections::HashMap<&str, String> = pairs.into_iter().collect();
        assert_eq!(map.get("lumen_enabled").map(String::as_str), Some("false"));
        assert_eq!(map.get("lumen_cli_path").map(String::as_str), Some(""));
        // 既有 5 键不回归
        assert!(map.contains_key("photoshop_path"));
        assert!(map.contains_key("thumbnail_width"));
        assert_eq!(map.len(), 7);
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
}
