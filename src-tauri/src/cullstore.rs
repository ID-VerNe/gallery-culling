//! 旗标独立存储：每个文件夹一份 `.gallerycull.json`。
//!
//! 为什么需要它：`xmp:Label` 是 Lightroom 的**色标**字段（红/黄/绿/蓝/紫），
//! 却被本应用借来编码 pick。后果是三重的 —— 读侧把用户的绿标误判成留用、
//! 写侧按 `P` 覆盖色标、按 `U` 清空色标，而「清空」又是清旗标的唯一手段，
//! 于是每次清除都在破坏用户数据。
//!
//! 这里给旗标一份自己的存储，把 `xmp:Label` 归还给色标。取舍见
//! `.plan/adr-001-cull-flag-store.md`。
//!
//! 两条纪律与 `xmp.rs` 保持一致：
//! - **读宽松、写严格**：`load` 读不懂就当空（绝不阻断扫描），`upsert` 读不懂就
//!   拒写（绝不降级成重建空文件，否则一次损坏就吃掉全部标记）。
//! - **原子写**：同目录临时文件 + rename，并发下读者永远看不到半个文件。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// 存储文件名。放在照片文件夹里，跟着文件夹一起拷走/备份。
pub const STORE_FILENAME: &str = ".gallerycull.json";
const STORE_VERSION: u32 = 1;

/// 串行化「读-改-写」。旗标写入是单次按键级的低频操作，一把全局锁足够，
/// 且不会与 XMP 的写锁嵌套（两者互不调用），不存在死锁面。
static WRITE_LOCK: Mutex<()> = Mutex::new(());
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// 单张照片的标记条目。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    /// `pick` | `reject` | `none`。空串按 `none` 处理。
    #[serde(default)]
    pub flag: String,
    /// 五色色标（预留；当前版本不写）。写旗标时必须原样保留。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct StoreFile {
    #[serde(default)]
    version: u32,
    #[serde(default, rename = "updatedAt")]
    updated_at: i64,
    #[serde(default)]
    entries: BTreeMap<String, Entry>,
}

/// 只读视图。缺失/损坏时是空 store。
#[derive(Debug, Default, Clone)]
pub struct Store {
    entries: BTreeMap<String, Entry>,
}

impl Store {
    pub fn get(&self, base_name: &str) -> Option<&Entry> {
        self.entries.get(&normalize_key(base_name))
    }
}

/// 键统一小写：配对用的是 `stem_lower`，而 `DSC_0001.JPG` 与 `dsc_0001.NEF`
/// 可能大小写不同。按原样存会让「读到的键」和「写时的键」对不上。
fn normalize_key(base_name: &str) -> String {
    base_name.trim().to_lowercase()
}

fn normalize_flag(flag: &str) -> Result<&'static str, String> {
    match flag.trim() {
        "pick" => Ok("pick"),
        "reject" => Ok("reject"),
        "none" | "" => Ok("none"),
        other => Err(format!("未知的旗标值: {}", other)),
    }
}

pub fn store_path(folder: &Path) -> PathBuf {
    folder.join(STORE_FILENAME)
}

/// 宽松读：扫描路径调用。文件不存在、JSON 损坏、版本过高 —— 一律当空 store，
/// 绝不让一份坏文件把整个文件夹扫不出来。
pub fn load(folder: &Path) -> Store {
    let text = match fs::read_to_string(store_path(folder)) {
        Ok(t) => t,
        Err(_) => return Store::default(),
    };
    match serde_json::from_str::<StoreFile>(&text) {
        Ok(file) => Store {
            entries: file.entries,
        },
        Err(_) => Store::default(),
    }
}

/// 严格读：写入路径调用。损坏就报错，绝不覆盖。
fn read_strict(folder: &Path) -> Result<StoreFile, String> {
    let path = store_path(folder);
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<StoreFile>(&text)
            .map_err(|e| format!("旗标文件格式损坏，拒绝覆盖（{}）: {}", path.display(), e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(StoreFile::default()),
        Err(e) => Err(format!("读取旗标文件失败（{}）: {}", path.display(), e)),
    }
}

/// 写入（或覆盖）一张照片的旗标，返回存储文件路径。
///
/// 只动 `flag`，**保留**已有 `label` —— 将来加了色标 UI，改旗标不能顺手清掉色标。
pub fn upsert(folder: &Path, base_name: &str, flag: &str) -> Result<PathBuf, String> {
    let flag = normalize_flag(flag)?;
    let key = normalize_key(base_name);
    if key.is_empty() {
        return Err("旗标写入缺少文件名".to_string());
    }

    let _guard = WRITE_LOCK
        .lock()
        .map_err(|e| format!("旗标写入锁异常: {}", e))?;

    let mut file = read_strict(folder)?;
    if file.version > STORE_VERSION {
        return Err(format!(
            "旗标文件版本（{}）高于本程序支持的版本（{}），拒绝改写；请升级程序",
            file.version, STORE_VERSION
        ));
    }
    file.version = STORE_VERSION;
    file.updated_at = now_secs();

    let mut entry = file.entries.remove(&key).unwrap_or_default();
    entry.flag = flag.to_string();
    file.entries.insert(key, entry);

    let text = serde_json::to_string_pretty(&file)
        .map_err(|e| format!("序列化旗标文件失败: {}", e))?;
    write_atomic(folder, &text)?;
    Ok(store_path(folder))
}

/// 决定一张照片的旗标。**唯一**的优先级真值，扫描与 LUMEN 同步都必须走这里。
///
/// 1. `xmp:Rating = -1` → reject（硬信号：Lightroom / LUMEN RAW 的通用淘汰约定，
///    任何外部工具写的淘汰都必须立刻生效，不能被本地旧条目压住）；
/// 2. 有本地条目 → 以条目为准（`"none"` 也是条目，用来压住旧 `Label=Green`）；
/// 3. 无条目 → 回落旧约定（`Green`→pick / `Red`→reject），只读不改写。
pub fn resolve_flag(
    rating_rejected: bool,
    legacy_label_flag: &str,
    entry: Option<&Entry>,
) -> String {
    if rating_rejected {
        return "reject".to_string();
    }
    match entry {
        // 坏条目（手改出错）按无条目处理，不让界面崩在一个字符串上。
        Some(e) => match normalize_flag(&e.flag) {
            Ok(f) => f.to_string(),
            Err(_) => legacy_label_flag.to_string(),
        },
        None => legacy_label_flag.to_string(),
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn write_atomic(folder: &Path, text: &str) -> Result<(), String> {
    let path = store_path(folder);
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    // 临时名带 `.json.tmp`：不会被当成本应用的存储文件，也不会在多线程间互相覆盖。
    let tmp = folder.join(format!(
        "{}.tmp{}_{}",
        STORE_FILENAME,
        std::process::id(),
        seq
    ));
    if let Err(e) = fs::write(&tmp, text) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("写入旗标文件失败（{}）: {}", tmp.display(), e));
    }
    if let Err(e) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("写入旗标文件失败（{}）: {}", path.display(), e));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个用例独立目录：测试并行跑，共用一个目录会互相踩。
    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gc_store_{}_{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    #[test]
    fn upsert_then_load_roundtrip() {
        let dir = tmp_dir("roundtrip");
        upsert(&dir, "DSC_0001", "pick").expect("写 pick");
        upsert(&dir, "dsc_0002", "reject").expect("写 reject");

        let store = load(&dir);
        assert_eq!(store.get("DSC_0001").map(|e| e.flag.as_str()), Some("pick"));
        // 大小写不敏感：写入用大写、读取用小写也必须命中
        assert_eq!(
            store.get("dsc_0001").map(|e| e.flag.as_str()),
            Some("pick")
        );
        assert_eq!(
            store.get("DSC_0002").map(|e| e.flag.as_str()),
            Some("reject")
        );
        assert!(store.get("DSC_9999").is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_is_empty_store() {
        let dir = tmp_dir("missing");
        let store = load(&dir);
        assert!(store.get("anything").is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn malformed_file_refuses_write_and_stays_untouched() {
        let dir = tmp_dir("malformed");
        let path = store_path(&dir);
        let broken = "{ \"entries\": { \"a\": ";
        fs::write(&path, broken).unwrap();

        // 读：宽松 → 空 store，不阻断扫描
        assert!(load(&dir).get("a").is_none());

        // 写：严格 → 报错，且文件字节不变（绝不覆盖用户数据）
        let err = upsert(&dir, "a", "pick").expect_err("损坏文件必须拒写");
        assert!(err.contains("损坏"), "错误信息应说明损坏: {}", err);
        assert_eq!(fs::read_to_string(&path).unwrap(), broken);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn future_version_refuses_write() {
        let dir = tmp_dir("future");
        let path = store_path(&dir);
        fs::write(&path, r#"{"version": 99, "entries": {}}"#).unwrap();
        let err = upsert(&dir, "a", "pick").expect_err("高版本必须拒写");
        assert!(err.contains("版本"), "错误信息应说明版本: {}", err);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_fields_are_ignored() {
        // 向前兼容：新版本加的字段不该让旧版本读崩/写崩
        let dir = tmp_dir("unknown");
        let path = store_path(&dir);
        fs::write(
            &path,
            r#"{"version":1,"entries":{"a":{"flag":"pick","futureField":42}}}"#,
        )
        .unwrap();
        assert_eq!(load(&dir).get("a").map(|e| e.flag.as_str()), Some("pick"));
        upsert(&dir, "a", "none").expect("应能继续写");
        assert_eq!(load(&dir).get("a").map(|e| e.flag.as_str()), Some("none"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn flag_write_preserves_existing_label() {
        let dir = tmp_dir("label");
        let path = store_path(&dir);
        fs::write(
            &path,
            r#"{"version":1,"entries":{"a":{"flag":"pick","label":"Red"}}}"#,
        )
        .unwrap();
        upsert(&dir, "a", "reject").expect("写 reject");
        let store = load(&dir);
        let entry = store.get("a").expect("条目仍在");
        assert_eq!(entry.flag, "reject");
        assert_eq!(entry.label.as_deref(), Some("Red"), "改旗标不得清色标");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_flag_is_rejected() {
        let dir = tmp_dir("badflag");
        let err = upsert(&dir, "a", "keep").expect_err("未知旗标必须拒写");
        assert!(err.contains("未知的旗标值"), "{}", err);
        // 拒写时不该留下文件
        assert!(!store_path(&dir).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_prefers_store_over_legacy_label() {
        let pick_entry = Entry {
            flag: "pick".into(),
            label: None,
        };
        let none_entry = Entry {
            flag: "none".into(),
            label: None,
        };
        // 旧文件 Label=Green（读成 pick），但用户后来按 U 清除 → 条目 none 必须压住
        assert_eq!(resolve_flag(false, "pick", Some(&none_entry)), "none");
        // 反过来：旧文件无色标，用户按 P → 条目 pick
        assert_eq!(resolve_flag(false, "none", Some(&pick_entry)), "pick");
        // 无条目 → 旧约定
        assert_eq!(resolve_flag(false, "pick", None), "pick");
        assert_eq!(resolve_flag(false, "reject", None), "reject");
        assert_eq!(resolve_flag(false, "none", None), "none");
    }

    #[test]
    fn resolve_keeps_rating_minus_one_authoritative() {
        // 外部（Lightroom / LUMEN）把 Rating 写成 -1，本地条目还是 pick：
        // 淘汰是硬信号，必须立刻生效。
        let pick_entry = Entry {
            flag: "pick".into(),
            label: None,
        };
        assert_eq!(resolve_flag(true, "none", Some(&pick_entry)), "reject");
        assert_eq!(resolve_flag(true, "pick", None), "reject");
    }

    #[test]
    fn resolve_ignores_corrupt_entry_value() {
        let bad = Entry {
            flag: "keep".into(),
            label: None,
        };
        // 坏条目回落旧约定，而不是把 "keep" 泄漏到界面
        assert_eq!(resolve_flag(false, "pick", Some(&bad)), "pick");
    }
}
