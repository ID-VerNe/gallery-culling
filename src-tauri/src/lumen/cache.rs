//! LUMEN 预览缓存：键计算、路径命名、原子落盘。
//!
//! 缓存键必须把「源文件 mtime + recipe 哈希 + 版本 + 变体 + 宽度」全部编进去，
//! 少一个都会让改了参数的用户看到上一次的旧预览。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::LumenError;
use super::PreviewVariant;
use super::PINNED_LUMEN_VERSION;
use super::recipe_hash;

/// 把可选时间戳编码进缓存键：None 与 Some(UNIX_EPOCH) 也必须可区分。
///
/// `pub(super)` 而非 `pub`：`detail` 模块复用它，但这不是对外 API。
pub(super) fn mtime_tag(mtime: Option<SystemTime>) -> u128 {
    match mtime {
        Some(t) => t
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(u128::MAX),
        None => u128::MAX,
    }
}

/// 计算预览缓存键：16 位小写 hex。
///
/// 输入任一变化（宽高/变体/版本/源文件 mtime/兄弟 .lumen mtime）→ key 变化。
pub fn lumen_cache_key(
    src: &Path,
    width: u32,
    variant: PreviewVariant,
    lumen_version: &str,
    src_mtime: Option<SystemTime>,
    project_mtime: Option<SystemTime>,
) -> String {
    lumen_cache_key_with_recipe(
        src,
        width,
        variant,
        lumen_version,
        src_mtime,
        project_mtime,
        None,
    )
}

/// 带 recipe 的缓存键。recipe 参与键是**硬要求**：改了色必须重新渲染，
/// 否则用户会看到上一次的图（Step 9 spec 不变量 N4）。
pub fn lumen_cache_key_with_recipe(
    src: &Path,
    width: u32,
    variant: PreviewVariant,
    lumen_version: &str,
    src_mtime: Option<SystemTime>,
    project_mtime: Option<SystemTime>,
    recipe: Option<&Value>,
) -> String {
    // 相对路径 canonicalize，保证同一文件不同写法同 key。
    let abs = src.canonicalize().unwrap_or_else(|_| src.to_path_buf());
    let variant_tag = match variant {
        PreviewVariant::Edited => "edited",
        PreviewVariant::Original => "orig",
    };
    // v2：新增 recipe 段。升级版本号会让所有旧缓存自然失效（一次性重渲染）。
    let recipe_tag = recipe.map(recipe_hash).unwrap_or_else(|| "-".to_string());
    let payload = format!(
        "lumen-preview-v2|{}|{}|{}|{}|{}|{}|{}",
        lumen_version,
        abs.display(),
        mtime_tag(src_mtime),
        mtime_tag(project_mtime),
        width,
        variant_tag,
        recipe_tag
    );
    let digest = Sha256::digest(payload.as_bytes());
    // 16 位小写 hex = 前 8 字节。
    digest
        .iter()
        .take(8)
        .map(|b| format!("{:02x}", b))
        .collect()
}

/// 预览产物落盘路径：`<cache_root>/lumen/<key>_<width>[_orig]_lumen.jpg`。
pub fn preview_cache_path(
    cache_root: &Path,
    key: &str,
    width: u32,
    variant: PreviewVariant,
) -> PathBuf {
    let suffix = match variant {
        PreviewVariant::Edited => "",
        PreviewVariant::Original => "_orig",
    };
    cache_root
        .join("lumen")
        .join(format!("{}_{}{}_lumen.jpg", key, width, suffix))
}

/// 组装 `render.preview` 的 JSON 参数（4 键，不得多键）。
pub fn preview_args(src: &Path, width: u32, variant: PreviewVariant, output: &Path) -> Value {
    serde_json::json!({
        "path": src.to_string_lossy(),
        "size": width,
        "original": matches!(variant, PreviewVariant::Original),
        "output": output.to_string_lossy(),
    })
}

/// 缓存命中判定：目标文件存在且是普通文件。
pub fn cached_preview(
    cache_root: &Path,
    key: &str,
    width: u32,
    variant: PreviewVariant,
) -> Option<PathBuf> {
    let path = preview_cache_path(cache_root, key, width, variant);
    path.is_file().then_some(path)
}

/// 预览缓存键的全部输入（打包以保持函数签名 ≤7 参数，clippy too_many_arguments）。
#[derive(Debug, Clone)]
pub struct PreviewCacheInputs {
    pub width: u32,
    pub variant: PreviewVariant,
    pub lumen_version: &'static str,
    pub src_mtime: Option<SystemTime>,
    pub project_mtime: Option<SystemTime>,
    /// 待渲染的调色 recipe（进缓存键 + 渲染参数）
    pub recipe: Option<Value>,
}

impl Default for PreviewCacheInputs {
    fn default() -> Self {
        Self {
            width: 1600,
            variant: PreviewVariant::Edited,
            lumen_version: PINNED_LUMEN_VERSION,
            src_mtime: None,
            project_mtime: None,
            recipe: None,
        }
    }
}

impl PreviewCacheInputs {
    pub fn key(&self, src: &Path) -> String {
        lumen_cache_key_with_recipe(
            src,
            self.width,
            self.variant,
            self.lumen_version,
            self.src_mtime,
            self.project_mtime,
            self.recipe.as_ref(),
        )
    }

    pub fn cache_path(&self, cache_root: &Path, key: &str) -> PathBuf {
        preview_cache_path(cache_root, key, self.width, self.variant)
    }
}

/// 预览渲染编排：命中缓存直接返回；否则 tmp 渲染 + 原子 rename。
///
/// `render` 是进程边界注入（真实实现为 `run_lumen(exe, "render.preview", args)`）。
pub fn ensure_preview(
    src: &Path,
    cache_root: &Path,
    inputs: PreviewCacheInputs,
    render: impl FnOnce(&Path, &Value) -> Result<(), LumenError>,
) -> Result<PathBuf, LumenError> {
    let key = inputs.key(src);
    let out = inputs.cache_path(cache_root, &key);
    if out.is_file() {
        return Ok(out); // 缓存命中：不碰渲染边界
    }

    let file_name = out
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| LumenError::Protocol("缓存路径非法".to_string()))?;
    let tmp = out
        .parent()
        .unwrap_or(cache_root)
        .join(format!("{}.tmp", file_name));

    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).map_err(|e| LumenError::Io(e.to_string()))?;
    }

    let args = preview_args(src, inputs.width, inputs.variant, &tmp);
    render(&tmp, &args)?;
    if !tmp.is_file() {
        return Err(LumenError::Protocol(
            "LUMEN RAW 未生成预览输出文件".to_string(),
        ));
    }
    std::fs::rename(&tmp, &out).map_err(|e| LumenError::Io(e.to_string()))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use crate::lumen::test_support::{ep_inputs, t_plus, tmp};
    use std::path::{Path, PathBuf};
    use std::time::SystemTime;
    use super::*;
    use crate::lumen::*;
// ---- B7 ----
fn key(src: &Path, width: u32, variant: PreviewVariant, m: Option<SystemTime>) -> String {
    lumen_cache_key(src, width, variant, "1.6.0", m, m)
}

#[test]
fn cache_key_is_deterministic() {
    let src = tmp("det.ARW");
    std::fs::write(&src, b"raw").unwrap();
    let k1 = key(&src, 1600, PreviewVariant::Edited, Some(t_plus(100)));
    let k2 = key(&src, 1600, PreviewVariant::Edited, Some(t_plus(100)));
    assert_eq!(k1, k2);
    let _ = std::fs::remove_file(&src);
}

#[test]
fn cache_key_canonicalizes_relative_paths() {
    // CARGO_MANIFEST_DIR=src-tauri；夹具文件是真实存在的相对路径。
    let rel = Path::new("tests/fixtures/lumen_fixture_ok.cmd");
    let abs = rel.canonicalize().unwrap();
    assert_eq!(
        key(rel, 1600, PreviewVariant::Edited, Some(t_plus(1))),
        key(&abs, 1600, PreviewVariant::Edited, Some(t_plus(1))),
        "相对路径必须先 canonicalize，与绝对路径同 key"
    );
}

#[test]
fn cache_key_changes_with_width() {
    let src = tmp("w.ARW");
    std::fs::write(&src, b"raw").unwrap();
    assert_ne!(
        key(&src, 1600, PreviewVariant::Edited, None),
        key(&src, 1200, PreviewVariant::Edited, None)
    );
    let _ = std::fs::remove_file(&src);
}

#[test]
fn cache_key_changes_with_variant() {
    let src = tmp("v.ARW");
    std::fs::write(&src, b"raw").unwrap();
    assert_ne!(
        key(&src, 1600, PreviewVariant::Edited, None),
        key(&src, 1600, PreviewVariant::Original, None)
    );
    let _ = std::fs::remove_file(&src);
}

#[test]
fn cache_key_changes_with_version() {
    let src = tmp("ver.ARW");
    std::fs::write(&src, b"raw").unwrap();
    let a = lumen_cache_key(&src, 1600, PreviewVariant::Edited, "1.6.0", None, None);
    let b = lumen_cache_key(&src, 1600, PreviewVariant::Edited, "1.7.0", None, None);
    assert_ne!(a, b);
    let _ = std::fs::remove_file(&src);
}

#[test]
fn cache_key_changes_with_src_mtime() {
    let src = tmp("m.ARW");
    std::fs::write(&src, b"raw").unwrap();
    let a = lumen_cache_key(
        &src,
        1600,
        PreviewVariant::Edited,
        "1.6.0",
        Some(t_plus(10)),
        None,
    );
    let b = lumen_cache_key(
        &src,
        1600,
        PreviewVariant::Edited,
        "1.6.0",
        Some(t_plus(11)),
        None,
    );
    assert_ne!(a, b, "源文件 mtime 变化必须换 key");
    let _ = std::fs::remove_file(&src);
}

#[test]
fn cache_key_changes_with_project_mtime() {
    let src = tmp("p.ARW");
    std::fs::write(&src, b"raw").unwrap();
    let none = lumen_cache_key(&src, 1600, PreviewVariant::Edited, "1.6.0", None, None);
    let some = lumen_cache_key(
        &src,
        1600,
        PreviewVariant::Edited,
        "1.6.0",
        None,
        Some(t_plus(5)),
    );
    assert_ne!(none, some, "None↔Some 必须换来 key（工程从未存 vs 已存）");
    let newer = lumen_cache_key(
        &src,
        1600,
        PreviewVariant::Edited,
        "1.6.0",
        None,
        Some(t_plus(6)),
    );
    assert_ne!(some, newer, ".lumen 被外部改过必须换 key");
    let _ = std::fs::remove_file(&src);
}

#[test]
fn cache_key_is_hex16() {
    let src = tmp("hex.ARW");
    std::fs::write(&src, b"raw").unwrap();
    let k = key(&src, 1600, PreviewVariant::Edited, Some(t_plus(3)));
    assert_eq!(k.len(), 16, "key 必须是 16 位，实际 {:?}", k);
    assert!(
        k.chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
        "key 必须全小写 hex，实际 {:?}",
        k
    );
    let _ = std::fs::remove_file(&src);
}

#[test]
fn cache_key_distinct_paths() {
    let a = tmp("dist_a.ARW");
    let b = tmp("dist_b.ARW");
    std::fs::write(&a, b"raw").unwrap();
    std::fs::write(&b, b"raw").unwrap();
    assert_ne!(
        key(&a, 1600, PreviewVariant::Edited, None),
        key(&b, 1600, PreviewVariant::Edited, None)
    );
    let _ = std::fs::remove_file(&a);
    let _ = std::fs::remove_file(&b);
}

// ---- B8 ----
#[test]
fn preview_cache_path_shape() {
    let root = tmp("cache_root");
    let p = preview_cache_path(&root, "abc123", 1600, PreviewVariant::Edited);
    assert_eq!(p.parent().unwrap().file_name().unwrap(), "lumen");
    assert_eq!(p.parent().unwrap().parent().unwrap(), root);
    assert_eq!(p.file_name().unwrap(), "abc123_1600_lumen.jpg");

    let p2 = preview_cache_path(&root, "abc123", 1600, PreviewVariant::Original);
    assert_eq!(p2.file_name().unwrap(), "abc123_1600_orig_lumen.jpg");
}

// ---- B9 ----
#[test]
fn display_messages_are_user_facing_chinese() {
    assert!(LumenError::NotInstalled.to_string().contains("未检测到"));
    assert!(LumenError::Usage("x".into())
        .to_string()
        .contains("应用内部缺陷"));
    assert!(LumenError::Exit(7).to_string().contains("Exit Code: 7"));
}

// ---- Step 2: B1 ----
#[test]
fn parse_lumen_version_standard_output() {
    assert_eq!(
        parse_lumen_version("LUMEN RAW 1.6.0\r\n"),
        Some("1.6.0".to_string())
    );
    assert_eq!(parse_lumen_version("1.6.0"), Some("1.6.0".to_string()));
}

#[test]
fn parse_lumen_version_rejects_junk() {
    assert_eq!(parse_lumen_version(""), None);
    assert_eq!(parse_lumen_version("LUMEN RAW"), None);
    assert_eq!(parse_lumen_version("garbage output"), None);
    assert_eq!(parse_lumen_version("LUMEN RAW vNext"), None);
}

// ---- Step 2: B2 ----
#[test]
fn preview_args_four_keys_exact() {
    let args = preview_args(
        Path::new(r"D:\shoot\DSC.CR2"),
        1600,
        PreviewVariant::Edited,
        Path::new(r"D:\cache\out.jpg"),
    );
    let obj = args.as_object().expect("应是对象");
    assert_eq!(
        obj.len(),
        4,
        "additionalProperties:false 下不得多键: {:?}",
        obj
    );
    assert_eq!(obj["path"], serde_json::json!(r"D:\shoot\DSC.CR2"));
    assert_eq!(obj["size"], serde_json::json!(1600));
    assert_eq!(obj["original"], serde_json::json!(false));
    assert_eq!(obj["output"], serde_json::json!(r"D:\cache\out.jpg"));
}

#[test]
fn preview_args_original_flag() {
    let args = preview_args(
        Path::new("a.ARW"),
        800,
        PreviewVariant::Original,
        Path::new("o.jpg"),
    );
    assert_eq!(args["original"], serde_json::json!(true));
    assert_eq!(args["size"], serde_json::json!(800));
}

// ---- Step 2: B3 ----
#[test]
fn cached_preview_hit_and_miss() {
    let root = tmp("cp_root");
    let hit = preview_cache_path(&root, "k1", 1600, PreviewVariant::Edited);
    std::fs::create_dir_all(hit.parent().unwrap()).unwrap();
    std::fs::write(&hit, b"jpg").unwrap();
    assert_eq!(
        cached_preview(&root, "k1", 1600, PreviewVariant::Edited),
        Some(hit)
    );

    // 不存在 → None
    assert_eq!(
        cached_preview(&root, "nope", 1600, PreviewVariant::Edited),
        None
    );

    // 是目录而非文件 → None
    let dir_as_file = preview_cache_path(&root, "kdir", 1600, PreviewVariant::Edited);
    std::fs::create_dir_all(&dir_as_file).unwrap();
    assert_eq!(
        cached_preview(&root, "kdir", 1600, PreviewVariant::Edited),
        None
    );
}

// ---- Step 2: B4 ----

#[test]
fn ensure_preview_cache_hit_skips_render() {
    let root = tmp("ep_root");
    let inputs = ep_inputs(Some(t_plus(1)));
    let out = inputs.cache_path(&root, &inputs.key(Path::new("src.ARW")));
    std::fs::create_dir_all(out.parent().unwrap()).unwrap();
    std::fs::write(&out, b"cached").unwrap();

    let mut called = false;
    let got = ensure_preview(Path::new("src.ARW"), &root, inputs, |_tmp, _args| {
        called = true;
        Err(LumenError::Command("不应被调用".into()))
    })
    .expect("命中应直接 Ok");
    assert!(!called, "缓存命中不得调用渲染边界");
    assert_eq!(got, out);
}

#[test]
fn ensure_preview_success_writes_tmp_then_renames() {
    let root = tmp("ep_ok");
    let inputs = ep_inputs(None);
    let out = inputs.cache_path(&root, &inputs.key(Path::new("src.ARW")));
    let tmp_expected = {
        let name = out.file_name().unwrap().to_string_lossy().to_string();
        out.parent().unwrap().join(format!("{}.tmp", name))
    };

    let got = ensure_preview(Path::new("src.ARW"), &root, inputs, |tmp, args| {
        assert_eq!(args["size"], serde_json::json!(1600));
        assert!(args["output"].as_str().unwrap().ends_with(".tmp"));
        std::fs::write(tmp, b"rendered").unwrap(); // 模拟 lumen 落盘
        Ok(())
    })
    .expect("渲染成功应 Ok");
    assert_eq!(got, out);
    assert!(out.is_file(), "最终产物应存在");
    assert!(!tmp_expected.exists(), "rename 后不得残留 tmp");
}

#[test]
fn ensure_preview_missing_output_is_protocol_error() {
    let root = tmp("ep_missing");
    let err = ensure_preview(
        Path::new("src.ARW"),
        &root,
        ep_inputs(None),
        |_tmp, _args| Ok(()), // “渲染成功”但什么都没写
    )
    .expect_err("输出缺失应 Err");
    assert!(matches!(err, LumenError::Protocol(_)), "实际: {:?}", err);
}

#[test]
fn ensure_preview_propagates_render_error_and_leaves_no_file() {
    let root = tmp("ep_err");
    let inputs = ep_inputs(None);
    let out = inputs.cache_path(&root, &inputs.key(Path::new("src.ARW")));
    let err = ensure_preview(Path::new("src.ARW"), &root, inputs, |_tmp, _args| {
        Err(LumenError::Command("lumen 炸了".into()))
    })
    .expect_err("渲染错误应透传");
    assert!(matches!(err, LumenError::Command(_)));
    assert!(!out.exists(), "失败时最终路径不得存在");
}

// ---- Step 2: B5 ----
#[test]
fn query_version_real_spawn_of_fixture() {
    // 真实 spawn .cmd 夹具（Rust Command 可直接执行 .cmd）：
    // 覆盖 query_version 的 成功解析路径（fixture 打印 "LUMEN RAW 1.6.0"）。
    assert_eq!(
        query_version(Path::new("tests/fixtures/lumen_fixture_version.cmd")),
        Some("1.6.0".to_string())
    );
    // ok 夹具打印的是 JSON 而非版本串 → None
    assert_eq!(
        query_version(Path::new("tests/fixtures/lumen_fixture_ok.cmd")),
        None
    );
}

#[test]
fn status_from_matrix() {
    let off = lumen_status_from(false, None, None);
    assert!(!off.available && !off.enabled);

    let no_exe = lumen_status_from(true, None, None);
    assert!(!no_exe.available && no_exe.enabled);

    let ok = lumen_status_from(
        true,
        Some(PathBuf::from(r"C:\lumen\lumen-cli.exe")),
        Some("1.6.0".into()),
    );
    assert!(ok.available);
    assert_eq!(ok.pinned_version, "1.6.0");
    assert_eq!(ok.found_version.as_deref(), Some("1.6.0"));

    // 版本漂移 → 不可用（A 报告 G4）
    let drift = lumen_status_from(true, Some(PathBuf::from("x.exe")), Some("1.7.0".into()));
    assert!(!drift.available);
    let noversion = lumen_status_from(true, Some(PathBuf::from("x.exe")), None);
    assert!(!noversion.available);
}

}
