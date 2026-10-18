//! RAW-only 1:1 细节缓存：键、路径、原子落盘与 LRU 淘汰。
//!
//! 与 `cache.rs`（1600 预览）**刻意分域**，不是重复实现：
//! - 预览：1.1s / 262MB 峰值 / 0.2MB 产物，翻图常驻，**不参与** 2GB 淘汰；
//! - 细节：6–8s / 761MB 峰值 / 4–6MB 产物，按需单张，2GB 上限只算它自己。
//!
//! 混在一起淘汰会把预览也删掉 —— 下次翻图又要 1.1s 重新渲染，而预览是
//! 每一次切换都发生的高频路径。所以两套缓存同目录、不同后缀、不同预算。
//!
//! 数据来源是 `photo.export`（**省略 `long_edge` = 原生尺寸**），不是
//! `render.preview`：后者被 `engine.load_image` 的 `preview_limit=1600`
//! 硬顶，`size=2048` 也只会返回 1069×1600（2026-10-18 实测，见报告 §5.4）。

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::cache::mtime_tag;
use super::recipe_hash;
use super::LumenError;

/// 细节 JPEG 质量。报告 §5.4 的实测取样用 95：24MP 产物 3.7–6.0MB。
pub const DETAIL_QUALITY: u8 = 95;

/// 细节缓存总上限。按 5MB/张算约 350–500 张（报告 §5.4 / R5 的缓解口径）。
pub const DETAIL_CACHE_LIMIT_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// 细节缓存键：16 位小写 hex。
///
/// 与预览键的差异是**域前缀 + 不含 width**：细节永远是原生尺寸，没有
/// 「宽边」这个维度；同时 recipe / 源 mtime / 工程 mtime / 版本都要进键，
/// 少一个都会让改了色的用户看到上一版细节。
pub fn detail_cache_key(
    src: &Path,
    lumen_version: &str,
    src_mtime: Option<SystemTime>,
    project_mtime: Option<SystemTime>,
    recipe: Option<&Value>,
) -> String {
    // 相对路径 canonicalize，保证同一文件不同写法同键（与预览键同口径）。
    let abs = src.canonicalize().unwrap_or_else(|_| src.to_path_buf());
    let recipe_tag = recipe.map(recipe_hash).unwrap_or_else(|| "-".to_string());
    // v1：细节域。与预览的 `lumen-preview-v2` 前缀不同 → 同输入也不撞键。
    let payload = format!(
        "lumen-detail-v1|{}|{}|{}|{}|{}",
        lumen_version,
        abs.display(),
        mtime_tag(src_mtime),
        mtime_tag(project_mtime),
        recipe_tag
    );
    let digest = Sha256::digest(payload.as_bytes());
    digest
        .iter()
        .take(8)
        .map(|b| format!("{:02x}", b))
        .collect()
}

/// 细节产物落盘路径：`<cache_root>/lumen/<key>_detail_lumen.jpg`。
///
/// 后缀与预览的 `<key>_<width>[_orig]_lumen.jpg` 必须可区分 —— 淘汰逻辑
/// 靠它认「哪些文件该算进 2GB 预算」。
pub fn detail_cache_path(cache_root: &Path, key: &str) -> PathBuf {
    cache_root
        .join("lumen")
        .join(format!("{}_detail_lumen.jpg", key))
}

/// `photo.export` 的参数：**不传 `long_edge`**（= 原生尺寸），quality 固定 95。
///
/// 报告原文写的是「`long_edge` 用原图长边（上限 20000）」，但省略键等价于
/// 「不缩放」，既不用先读一遍尺寸，也不会被 schema 的 20000 上限截断。
pub fn detail_args(photo: &Path, output: &Path) -> Value {
    // 复用导出参数构造：`long_edge=None` 时它**省略键**（发 null 会被拒）。
    super::build_export_args(
        &photo.to_string_lossy(),
        &output.to_string_lossy(),
        DETAIL_QUALITY,
        None,
    )
}

/// 细节缓存键的全部输入（打包以保持签名 ≤7 参数）。
#[derive(Debug, Clone)]
pub struct DetailCacheInputs {
    pub lumen_version: &'static str,
    pub src_mtime: Option<SystemTime>,
    pub project_mtime: Option<SystemTime>,
    pub recipe: Option<Value>,
}

impl Default for DetailCacheInputs {
    fn default() -> Self {
        Self {
            lumen_version: super::PINNED_LUMEN_VERSION,
            src_mtime: None,
            project_mtime: None,
            recipe: None,
        }
    }
}

impl DetailCacheInputs {
    pub fn key(&self, src: &Path) -> String {
        detail_cache_key(
            src,
            self.lumen_version,
            self.src_mtime,
            self.project_mtime,
            self.recipe.as_ref(),
        )
    }

    pub fn cache_path(&self, cache_root: &Path, key: &str) -> PathBuf {
        detail_cache_path(cache_root, key)
    }
}

/// 细节渲染编排：命中缓存直接返回；否则 tmp 渲染 + 原子 rename。
///
/// `render` 是进程边界注入（生产是 `export_photo`，单测是写固定字节）。
/// 与 `ensure_preview` 同款语义：**失败时最终路径不得存在**，否则下一次
/// 命中会返回一个 0 字节的坏图。
pub fn ensure_detail(
    src: &Path,
    cache_root: &Path,
    inputs: DetailCacheInputs,
    render: impl FnOnce(&Path, &Value) -> Result<(), LumenError>,
) -> Result<PathBuf, LumenError> {
    let key = inputs.key(src);
    let out = inputs.cache_path(cache_root, &key);
    if out.is_file() {
        return Ok(out); // 缓存命中：不碰渲染边界（6–8s 省下来）
    }

    let file_name = out
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| LumenError::Protocol("缓存路径非法".to_string()))?;
    // 临时文件名必须**保留 `.jpg` 结尾**：`photo.export` 会校验 output 的扩展名
    // （`output must end in .jpg, .png, .tif or .dng`），`<name>.jpg.tmp` 直接被
    // 拒。预览那条路侥幸没踩到（`render.preview` 不校验扩展名），所以单测里
    // 「写固定字节」的假渲染器一路绿 —— 真机冒烟一跑就红，正是它该抓的东西。
    let tmp_name = file_name
        .rsplit_once('.')
        .map(|(stem, ext)| format!("{stem}.tmp.{ext}"))
        .unwrap_or_else(|| format!("{file_name}.tmp"));
    let tmp = out.parent().unwrap_or(cache_root).join(tmp_name);

    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).map_err(|e| LumenError::Io(e.to_string()))?;
    }

    let args = detail_args(src, &tmp);
    render(&tmp, &args)?;
    if !tmp.is_file() {
        return Err(LumenError::Protocol(
            "LUMEN RAW 未生成细节输出文件".to_string(),
        ));
    }
    std::fs::rename(&tmp, &out).map_err(|e| LumenError::Io(e.to_string()))?;
    Ok(out)
}

/// 淘汰结果（诊断用；UI 不展示）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EvictReport {
    pub removed: usize,
    pub freed_bytes: u64,
}

/// 纯判定：给定 `(路径, 字节数, mtime)`，返回**应从旧到新删除**的下标。
///
/// 抽成纯函数是为了让「删谁」能被直接断言，不必真造 2GB 文件。
/// mtime 相同按路径升序 tie-break —— 没有它，同一秒内写出的多张图在
/// 不同文件系统枚举顺序下会给出不同结果，测试也就不稳定。
pub fn plan_eviction(entries: &[(PathBuf, u64, SystemTime)], limit: u64) -> Vec<usize> {
    let total: u64 = entries.iter().map(|e| e.1).sum();
    if total <= limit {
        return Vec::new();
    }

    let mut order: Vec<usize> = (0..entries.len()).collect();
    order.sort_by(|&i, &j| {
        entries[i]
            .2
            .cmp(&entries[j].2)
            .then_with(|| entries[i].0.cmp(&entries[j].0))
    });

    let mut remaining = total;
    let mut doomed = Vec::new();
    for i in order {
        if remaining <= limit {
            break;
        }
        remaining = remaining.saturating_sub(entries[i].1);
        doomed.push(i);
    }
    doomed
}

/// 按 2GB 预算淘汰细节缓存。目录不存在 / 读不了 = 无事发生。
///
/// 只认 `*_detail_lumen.jpg`：预览缓存（`*_<width>_lumen.jpg`）、导出产物、
/// 其它任何文件都不参与 —— 这条边界由 `only_touches_detail_files` 锁死。
///
/// 删不掉的（正在被 `asset://` 读取、被杀毒软件占着）静默跳过：它仍然占空间，
/// 但下次淘汰还会再来一次，不需要在这里报错打扰用户。
pub fn evict_detail_cache(cache_root: &Path, limit: u64) -> EvictReport {
    let dir = cache_root.join("lumen");
    let Ok(read_dir) = std::fs::read_dir(&dir) else {
        return EvictReport::default(); // 目录还没建（从未渲染过细节）
    };

    let mut entries: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    for entry in read_dir.flatten() {
        let path = entry.path();
        if !is_detail_cache_file(&path) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let Ok(mtime) = meta.modified() else { continue };
        entries.push((path, meta.len(), mtime));
    }

    let mut report = EvictReport::default();
    for i in plan_eviction(&entries, limit) {
        let (path, len, _) = &entries[i];
        if std::fs::remove_file(path).is_ok() {
            report.removed += 1;
            report.freed_bytes += len;
        }
        // 删不掉（asset:// 正在读、杀毒软件占用）：仍占空间，下次再来。
    }
    report
}

/// 文件名是否是细节缓存产物（淘汰的唯一判定入口）。
///
/// 也算上 `*_detail_lumen.tmp.jpg`：那是渲染中途的临时文件，进程被杀 / 断电
/// 会留下 4–6MB 残file。不认它，这些文件就永远在 2GB 预算之外（预算只统计
/// 它认识的），越积越多。淘汰只在渲染成功后调用、而渲染是单飞的，所以不会
/// 删到正在写的那份。
pub fn is_detail_cache_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.ends_with("_detail_lumen.jpg") || n.ends_with("_detail_lumen.tmp.jpg"))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lumen::test_support::tmp;
    use std::time::{Duration, UNIX_EPOCH};

    fn t(secs: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(secs)
    }

    fn inputs(recipe: Option<Value>) -> DetailCacheInputs {
        DetailCacheInputs {
            lumen_version: "1.6.0",
            src_mtime: Some(t(100)),
            project_mtime: None,
            recipe,
        }
    }

    // ---- 键 ----

    #[test]
    fn cache_key_is_deterministic() {
        let src = tmp("detail_det.ARW");
        std::fs::write(&src, b"raw").unwrap();
        let a = detail_cache_key(&src, "1.6.0", Some(t(100)), None, None);
        let b = detail_cache_key(&src, "1.6.0", Some(t(100)), None, None);
        assert_eq!(a, b);
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn cache_key_changes_with_recipe() {
        let src = tmp("detail_recipe.ARW");
        std::fs::write(&src, b"raw").unwrap();
        let none = detail_cache_key(&src, "1.6.0", Some(t(100)), None, None);
        let some = detail_cache_key(
            &src,
            "1.6.0",
            Some(t(100)),
            None,
            Some(&serde_json::json!({"adjustments": {"exposure": 0.5}})),
        );
        assert_ne!(none, some, "改了色必须重新出细节，否则看到上一版");
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn cache_key_changes_with_src_mtime() {
        let src = tmp("detail_mtime.ARW");
        std::fs::write(&src, b"raw").unwrap();
        assert_ne!(
            detail_cache_key(&src, "1.6.0", Some(t(100)), None, None),
            detail_cache_key(&src, "1.6.0", Some(t(101)), None, None),
            "源文件换过必须换键"
        );
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn cache_key_differs_from_preview_key() {
        // 同输入下两个域必须不同键 —— 否则细节产物会被预览的命中判定当成
        // 自己的缓存（`cached_preview` 按 preview 路径找，撞不上；但把两者
        // 混成一个键会让将来的排查彻底失去区分度）。
        let src = tmp("detail_domain.ARW");
        std::fs::write(&src, b"raw").unwrap();
        let detail = detail_cache_key(&src, "1.6.0", Some(t(100)), None, None);
        let preview = crate::lumen::lumen_cache_key_with_recipe(
            &src,
            1600,
            crate::lumen::PreviewVariant::Edited,
            "1.6.0",
            Some(t(100)),
            None,
            None,
        );
        assert_ne!(detail, preview, "细节与预览必须是不同的键域");
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn cache_key_is_hex16() {
        let src = tmp("detail_hex.ARW");
        std::fs::write(&src, b"raw").unwrap();
        let k = detail_cache_key(&src, "1.6.0", Some(t(3)), None, None);
        assert_eq!(k.len(), 16, "键必须是 16 位，实际 {:?}", k);
        assert!(
            k.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "键必须全小写 hex，实际 {:?}",
            k
        );
        let _ = std::fs::remove_file(&src);
    }

    // ---- 路径与参数 ----

    #[test]
    fn cache_path_shape() {
        let root = tmp("detail_root");
        let p = detail_cache_path(&root, "abc123");
        assert_eq!(p.parent().unwrap().file_name().unwrap(), "lumen");
        assert_eq!(p.parent().unwrap().parent().unwrap(), root);
        assert_eq!(p.file_name().unwrap(), "abc123_detail_lumen.jpg");
    }

    #[test]
    fn detail_args_omit_long_edge() {
        let args = detail_args(Path::new(r"D:\shoot\A.ARW"), Path::new(r"D:\c\out.jpg"));
        assert!(
            args.get("long_edge").is_none(),
            "必须省略 long_edge（省略 = 原生尺寸）；发 null 会被 schema 拒绝"
        );
        assert_eq!(args["quality"], serde_json::json!(DETAIL_QUALITY));
        assert_eq!(args["overwrite"], serde_json::json!(false));
        assert_eq!(
            args.as_object().unwrap().len(),
            4,
            "photo.export 只认这四个键，实际 {:?}",
            args
        );
    }

    // ---- 落盘 ----

    #[test]
    fn ensure_detail_cache_hit_skips_render() {
        let root = tmp("detail_ep_root");
        let inputs = inputs(None);
        let out = inputs.cache_path(&root, &inputs.key(Path::new("src.ARW")));
        std::fs::create_dir_all(out.parent().unwrap()).unwrap();
        std::fs::write(&out, b"cached").unwrap();

        let mut called = false;
        let got = ensure_detail(Path::new("src.ARW"), &root, inputs, |_tmp, _args| {
            called = true;
            Err(LumenError::Command("不应被调用".into()))
        })
        .expect("命中应直接 Ok");
        assert!(!called, "缓存命中不得调用渲染边界");
        assert_eq!(got, out);
    }

    #[test]
    fn ensure_detail_success_writes_tmp_then_renames() {
        let root = tmp("detail_ep_ok");
        let inputs = inputs(None);
        let out = inputs.cache_path(&root, &inputs.key(Path::new("src.ARW")));
        let tmp_expected = {
            let name = out.file_name().unwrap().to_string_lossy().to_string();
            let (stem, ext) = name.rsplit_once('.').unwrap();
            out.parent().unwrap().join(format!("{stem}.tmp.{ext}"))
        };

        let got = ensure_detail(Path::new("src.ARW"), &root, inputs, |tmp, args| {
            assert!(args.get("long_edge").is_none(), "细节必须是原生尺寸");
            // 真机冒烟抓到的：`photo.export` 校验 output 扩展名，
            // `<name>.jpg.tmp` 会被拒（output must end in .jpg/.png/.tif/.dng）。
            // 假渲染器不校验，所以这条断言是那个 bug 唯一的单测哨兵。
            let output = args["output"].as_str().unwrap();
            assert!(
                output.ends_with(".jpg"),
                "photo.export 要求 output 以图片扩展名结尾，实际: {output}"
            );
            assert!(output.contains(".tmp."), "仍是临时文件: {output}");
            std::fs::write(tmp, b"rendered").unwrap();
            Ok(())
        })
        .expect("渲染成功应 Ok");
        assert_eq!(got, out);
        assert!(out.is_file(), "最终产物应存在");
        assert!(!tmp_expected.exists(), "rename 后不得残留 tmp");
    }

    #[test]
    fn ensure_detail_missing_output_is_protocol_error() {
        let root = tmp("detail_ep_missing");
        let err = ensure_detail(Path::new("src.ARW"), &root, inputs(None), |_t, _a| Ok(()))
            .expect_err("输出缺失应 Err");
        assert!(matches!(err, LumenError::Protocol(_)), "实际: {:?}", err);
    }

    #[test]
    fn ensure_detail_propagates_error_and_leaves_no_file() {
        let root = tmp("detail_ep_err");
        let inputs = inputs(None);
        let out = inputs.cache_path(&root, &inputs.key(Path::new("src.ARW")));
        let err = ensure_detail(Path::new("src.ARW"), &root, inputs, |_t, _a| {
            Err(LumenError::Command("lumen 炸了".into()))
        })
        .expect_err("渲染错误应透传");
        assert!(matches!(err, LumenError::Command(_)));
        assert!(!out.exists(), "失败时最终路径不得存在");
    }

    // ---- 淘汰判定（纯函数）----

    #[test]
    fn plan_keeps_everything_under_limit() {
        let entries = vec![
            (PathBuf::from("a"), 100, t(1)),
            (PathBuf::from("b"), 100, t(2)),
        ];
        assert!(plan_eviction(&entries, 200).is_empty(), "刚好等于上限不删");
        assert!(plan_eviction(&entries, 1000).is_empty());
    }

    #[test]
    fn plan_removes_oldest_first() {
        let entries = vec![
            (PathBuf::from("new"), 100, t(300)),
            (PathBuf::from("old"), 100, t(100)),
            (PathBuf::from("mid"), 100, t(200)),
        ];
        // 300 → 上限 250：删掉最旧的 100 就够
        assert_eq!(plan_eviction(&entries, 250), vec![1]);
        // 300 → 上限 150：删两个最旧的
        assert_eq!(plan_eviction(&entries, 150), vec![1, 2]);
        // 上限 0：全删
        assert_eq!(plan_eviction(&entries, 0), vec![1, 2, 0]);
    }

    #[test]
    fn plan_tie_breaks_by_path() {
        let entries = vec![
            (PathBuf::from("b"), 100, t(100)),
            (PathBuf::from("a"), 100, t(100)),
        ];
        assert_eq!(
            plan_eviction(&entries, 100),
            vec![1],
            "mtime 相同必须按路径 tie-break（否则枚举顺序不同结果就不同）"
        );
    }

    #[test]
    fn plan_empty_is_empty() {
        assert!(plan_eviction(&[], 0).is_empty());
    }

    // ---- 真删 ----

    #[test]
    fn is_detail_cache_file_matches_only_detail_suffix() {
        assert!(is_detail_cache_file(Path::new(
            "D:/c/lumen/abc_detail_lumen.jpg"
        )));
        assert!(!is_detail_cache_file(Path::new(
            "D:/c/lumen/abc_1600_lumen.jpg"
        )));
        assert!(!is_detail_cache_file(Path::new(
            "D:/c/lumen/abc_detail_lumen.jpg.tmp"
        )));
        // 现行临时名（保留 .jpg 结尾才过得了 photo.export 的扩展名校验）：
        // 必须算进预算，否则崩一次就留下 4–6MB 永远不计的残file。
        assert!(is_detail_cache_file(Path::new(
            "D:/c/lumen/abc_detail_lumen.tmp.jpg"
        )));
        assert!(!is_detail_cache_file(Path::new("D:/c/lumen/other.jpg")));
    }

    #[test]
    fn evict_only_touches_detail_files() {
        let root = tmp("detail_evict_root");
        let dir = root.join("lumen");
        std::fs::create_dir_all(&dir).unwrap();
        let detail = dir.join("a_detail_lumen.jpg");
        let preview = dir.join("a_1600_lumen.jpg");
        let other = dir.join("notes.txt");
        for p in [&detail, &preview, &other] {
            std::fs::write(p, vec![0u8; 100]).unwrap();
        }

        let report = evict_detail_cache(&root, 0);
        assert_eq!(report.removed, 1, "只该删掉细节产物");
        assert!(!detail.exists(), "细节产物应被删");
        assert!(preview.exists(), "预览缓存不得被动");
        assert!(other.exists(), "无关文件不得被动");
    }

    #[test]
    fn evict_removes_until_under_limit() {
        let root = tmp("detail_evict_limit");
        let dir = root.join("lumen");
        std::fs::create_dir_all(&dir).unwrap();
        // 4 个 100 字节的细节产物 = 400，上限 250 → 必须删 2 个
        for i in 0..4 {
            let p = dir.join(format!("f{}_detail_lumen.jpg", i));
            std::fs::write(&p, vec![0u8; 100]).unwrap();
            // 明确拉开 mtime，避免文件系统同秒精度让顺序不可预期
            let secs = 1000 + i as u64;
            let mtime = UNIX_EPOCH + Duration::from_secs(secs);
            let f = std::fs::File::options().write(true).open(&p).unwrap();
            f.set_modified(mtime).unwrap();
        }

        let report = evict_detail_cache(&root, 250);
        assert_eq!(report.removed, 2, "400 → ≤250 至少删 2 个");
        assert!(report.freed_bytes >= 200);
        let left = std::fs::read_dir(&dir).unwrap().count();
        assert_eq!(left, 2);
    }

    #[test]
    fn evict_missing_dir_is_noop() {
        let root = tmp("detail_evict_missing");
        let report = evict_detail_cache(&root, 0);
        assert_eq!(report, EvictReport::default());
    }
}
