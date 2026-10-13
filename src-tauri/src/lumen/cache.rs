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
fn mtime_tag(mtime: Option<SystemTime>) -> u128 {
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
