//! MCP 工具名映射与 AI 蒙版载荷构造。

use serde_json::Value;

use super::{json_f32, LumenError};

/// MCP 工具名 → 命令 id（B 通道 `run` 只认命令 id）。
pub(super) fn tool_to_command_id(tool: &str) -> &'static str {
    match tool {
        "rate_photos" => "library.rate",
        "flag_photos" => "library.flag",
        "label_photos" => "library.label",
        "render_preview" => "render.preview",
        "get_edits" => "edit.get",
        "apply_edits" => "edit.apply",
        _ => "app.status",
    }
}

/// 中文/英文区域名 → lumen region id。
///
/// 宿主 UI 用中文展示，但 .lumen 工程与命令载荷必须落英文 id（读回时才认得出）。
pub fn normalize_mask_region(input: &str) -> Option<&'static str> {
    let lowered = input.trim().to_ascii_lowercase();
    Some(match lowered.as_str() {
        "sky" | "天空" => "sky",
        "subject" | "主体" => "subject",
        "person" | "人像" | "人物" => "person",
        "background" | "背景" => "background",
        "foreground" | "前景" => "foreground",
        "top" | "顶部" => "top",
        "bottom" | "底部" => "bottom",
        "edges" | "边缘" => "edges",
        _ => return None,
    })
}

/// 构造 `edit.apply` 的 masks 载荷。
///
/// 形状来自真实 sidecar 的命令 schema 与实跑结果：`masks` 是
/// `[{region, adjustments}]`（新蒙版，region 由 AI 本地检测），一次最多 4 个。
/// 实跑确认 region 也接受中文自然语言（返回名如"天空（自然语言）"），但写英文 id 最稳。
pub fn mask_changes(
    region: &str,
    adjustments: &crate::models::MaskAdjustments,
) -> Result<Value, LumenError> {
    let region = normalize_mask_region(region)
        .ok_or_else(|| LumenError::Command(format!("未知的 AI 蒙版区域: {}", region)))?;
    Ok(serde_json::json!({
        "masks": [{
            "region": region,
            "adjustments": {
                "exposure": json_f32(adjustments.exposure),
                "highlights": json_f32(adjustments.highlights),
                "shadows": json_f32(adjustments.shadows),
                "dehaze": json_f32(adjustments.dehaze),
                "clarity": json_f32(adjustments.clarity),
                "saturation": json_f32(adjustments.saturation),
                "temperature": json_f32(adjustments.temperature.clamp(-100.0, 100.0)),
            },
        }]
    }))
}

/// 读回工程里的蒙版列表（`.lumen` 跨进程可读）。
pub fn project_masks(state: &Value) -> Vec<Value> {
    state
        .get("masks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use crate::lumen::test_support::{ep_inputs, t_plus};
    use crate::lumen::test_support::tmp;
    use super::*;
    use crate::lumen::*;
// ---- AI 蒙版 ----
#[test]
fn mask_region_normalizes_chinese_and_english() {
    for (input, expect) in [
        ("sky", "sky"),
        ("天空", "sky"),
        ("  Sky ", "sky"),
        ("人像", "person"),
        ("人物", "person"),
        ("主体", "subject"),
        ("边缘", "edges"),
    ] {
        assert_eq!(normalize_mask_region(input), Some(expect), "输入 {}", input);
    }
    assert_eq!(normalize_mask_region("月面"), None, "未知区域应拒绝");
    assert_eq!(normalize_mask_region(""), None);
}

#[test]
fn mask_changes_payload_matches_lumen_schema() {
    let adj = crate::models::MaskAdjustments {
        dehaze: 60.0,
        ..Default::default()
    };
    let changes = mask_changes("天空", &adj).expect("天空应被接受");
    let masks = changes["masks"].as_array().expect("masks 应是数组");
    assert_eq!(masks.len(), 1);
    assert_eq!(masks[0]["region"], "sky", "中文要归一成英文 id");
    assert_eq!(masks[0]["adjustments"]["dehaze"], serde_json::json!(60.0));
    // 未设置的字段必须是 0 而不是缺失（lumen 按最终值覆盖）
    let a = &masks[0]["adjustments"];
    for k in ["exposure", "clarity", "saturation", "temperature"] {
        assert_eq!(a[k], serde_json::json!(0.0), "{} 应为 0", k);
    }
    // temperature 夹紧
    let hot = crate::models::MaskAdjustments {
        temperature: 9999.0,
        ..Default::default()
    };
    assert_eq!(
        mask_changes("sky", &hot).unwrap()["masks"][0]["adjustments"]["temperature"],
        serde_json::json!(100.0)
    );
    // 未知区域必须报错而不是静默通过
    assert!(mask_changes("月球背面", &adj).is_err());
}

#[test]
fn tone_to_recipe_includes_temperature_after_unit_alignment() {
    let tone = crate::models::ToneAdjustments {
        exposure: 0.65,
        highlights: -20.0,
        shadows: 45.0,
        temperature: 30.0,
        tint: 5.0,
        contrast: 10.0,
    };
    // 单位已统一（两侧都是 ±100 相对）：六个字段全部直通
    let obj = tone_to_recipe(&tone, true)["adjustments"].clone();
    let map = obj.as_object().unwrap();
    assert_eq!(map.len(), 6, "六个滑杆都该透传，实际: {:?}", map);
    assert_eq!(map["exposure"], serde_json::json!(0.65));
    assert_eq!(map["highlights"], serde_json::json!(-20.0));
    assert_eq!(map["temperature"], serde_json::json!(30.0));
    // 旧开关保留只为兼容旧调用点
    let legacy = tone_to_recipe(&tone, false)["adjustments"].clone();
    assert!(!legacy.as_object().unwrap().contains_key("temperature"));
}

#[test]
fn tone_to_recipe_clamps_temperature_to_slider_range() {
    // lumen 侧实测会把 500 截断成 100；宿主先夹紧则两侧行为一致，
    // 也避免把非法值写进 .lumen 工程。
    let high = crate::models::ToneAdjustments {
        temperature: 5350.0,
        ..Default::default()
    };
    assert_eq!(
        tone_to_recipe(&high, true)["adjustments"]["temperature"],
        serde_json::json!(100.0)
    );
    let low = crate::models::ToneAdjustments {
        temperature: -900.0,
        ..Default::default()
    };
    assert_eq!(
        tone_to_recipe(&low, true)["adjustments"]["temperature"],
        serde_json::json!(-100.0)
    );
}

#[test]
fn tone_divergence_rules() {
    let base = crate::models::ToneAdjustments {
        exposure: 0.5,
        highlights: -10.0,
        shadows: 20.0,
        temperature: 30.0,
        tint: 5.0,
        contrast: 10.0,
    };
    assert!(
        !LumenRuntime::tone_diverges(&base, &base),
        "相同值不该算分歧"
    );
    // 浮点噪声不算分歧
    let mut noisy = base.clone();
    noisy.exposure = 0.5 + 1e-6;
    assert!(!LumenRuntime::tone_diverges(&base, &noisy));
    // 任一字段不同即分歧（六个字段逐个钉死）
    let mut hits = 0;
    for field in [
        "exposure",
        "highlights",
        "shadows",
        "temperature",
        "tint",
        "contrast",
    ] {
        let mut other = base.clone();
        match field {
            "exposure" => other.exposure += 0.1,
            "highlights" => other.highlights += 0.1,
            "shadows" => other.shadows += 0.1,
            "temperature" => other.temperature += 1.0,
            "tint" => other.tint += 0.1,
            "contrast" => other.contrast += 0.1,
            _ => unreachable!(),
        }
        assert!(
            LumenRuntime::tone_diverges(&base, &other),
            "字段 {} 变化应算分歧",
            field
        );
        hits += 1;
    }
    assert_eq!(hits, 6);
}

#[test]
fn recipe_to_tone_clamps_temperature() {
    let state = serde_json::json!({"adjustments": {"temperature": 400.0}});
    assert_eq!(recipe_to_tone(&state).temperature, 100.0, "越界回读应夹紧");
}

#[test]
fn recipe_to_tone_defaults_missing_fields() {
    let state = serde_json::json!({
        "adjustments": { "exposure": 0.5, "highlights": -10.0 }
    });
    let t = recipe_to_tone(&state);
    assert_eq!(t.exposure, 0.5);
    assert_eq!(t.highlights, -10.0);
    assert_eq!(t.shadows, 0.0, "缺失字段应为 0");
    assert_eq!(t.contrast, 0.0);
    // 空状态
    let empty = recipe_to_tone(&serde_json::json!({}));
    assert_eq!(empty.exposure, 0.0);
}

#[test]
fn recipe_requires_live_session_channel() {
    // 无常驻连接时 apply_recipe 必须失败（而不是假装成功）：
    // lumen 的编辑状态是进程内 session，B 通道单发不落盘。
    let rt = LumenRuntime::new();
    assert!(!rt.has_live_client(), "新建运行时不应有客户端");
    let err = rt
        .apply_recipe(
            Path::new(
                r"C:
ope\lumen-cli-xyz.exe",
            ),
            "x.ARW",
            &serde_json::json!({"adjustments": {"exposure": 1.0}}),
        )
        .expect_err("无常驻通道时不应成功");
    assert!(matches!(err, LumenError::NotInstalled), "实际: {:?}", err);
}

#[test]
fn recipe_hash_is_canonical_and_recipe_sensitive() {
    // 键顺序不同 → 同 hash
    let a = serde_json::json!({"adjustments": {"exposure": 0.3, "tint": 0.1}});
    let b = serde_json::json!({"adjustments": {"tint": 0.1, "exposure": 0.3}});
    assert_eq!(recipe_hash(&a), recipe_hash(&b), "键顺序不应影响 hash");
    // 浮点抖动归一
    let c = serde_json::json!({"exposure": 0.30000000000000004});
    let d = serde_json::json!({"exposure": 0.3});
    assert_eq!(recipe_hash(&c), recipe_hash(&d), "浮点抖动应归一");
    // 值不同 → hash 不同
    assert_ne!(
        recipe_hash(&a),
        recipe_hash(&serde_json::json!({"exposure": 0.9}))
    );
}

#[test]
fn cache_key_includes_recipe() {
    // 真实签名：同一张图、同样的 mtime，只有 recipe 不同 → key 必须不同。
    let src = Path::new("src.ARW");
    let a = lumen_cache_key_with_recipe(
        src,
        1600,
        PreviewVariant::Edited,
        PINNED_LUMEN_VERSION,
        None,
        None,
        None,
    );
    let b = lumen_cache_key_with_recipe(
        src,
        1600,
        PreviewVariant::Edited,
        PINNED_LUMEN_VERSION,
        None,
        None,
        Some(&serde_json::json!({"adjustments": {"exposure": 0.5}})),
    );
    let c = lumen_cache_key_with_recipe(
        src,
        1600,
        PreviewVariant::Edited,
        PINNED_LUMEN_VERSION,
        None,
        None,
        Some(&serde_json::json!({"adjustments": {"exposure": 0.9}})),
    );
    assert_ne!(a, b, "加了 recipe 必须换缓存条目（否则改色返旧图）");
    assert_ne!(b, c, "recipe 值不同 → key 不同");
    // 等价 recipe（键序不同）→ 同 key，不浪费缓存
    let d = lumen_cache_key_with_recipe(
        src,
        1600,
        PreviewVariant::Edited,
        PINNED_LUMEN_VERSION,
        None,
        None,
        Some(&serde_json::json!({"adjustments": {"tint": 0.0, "exposure": 0.5}})),
    );
    assert_ne!(d, b);
    // PreviewCacheInputs 走同一条路径
    let mut inputs = ep_inputs(None);
    inputs.recipe = Some(serde_json::json!({"adjustments": {"exposure": 0.5}}));
    assert_eq!(inputs.key(src), b, "PreviewCacheInputs 必须用同一个键算法");
}

#[test]
fn recipe_changes_re_render_through_ensure_preview() {
    // 端到端（缓存层）：改 recipe → ensure_preview 必须真的重渲染，而不是命中旧图
    let root = tmp("ep_recipe");
    let src_path = tmp("ep_recipe_src");
    std::fs::write(&src_path, b"raw").unwrap();
    let mut inputs = ep_inputs(Some(t_plus(1)));

    // 计数器与"抓到的渲染参数"用 Cell，闭包可重复传入
    let calls = std::cell::Cell::new(0);
    let seen = std::cell::RefCell::new(None);
    let render = |tmp: &Path, args: &Value| {
        calls.set(calls.get() + 1);
        *seen.borrow_mut() = Some(args.clone());
        std::fs::write(tmp, b"rendered").map_err(|e| LumenError::Io(e.to_string()))
    };

    // 第一次：无 recipe
    let a = ensure_preview(&src_path, &root, inputs.clone(), render).unwrap();
    let first = std::fs::read(&a).unwrap();

    // 同 recipe → 命中缓存（渲染闭包不该再被调用）
    let a2 = ensure_preview(&src_path, &root, inputs.clone(), render).unwrap();
    assert_eq!(std::fs::read(&a2).unwrap(), first);
    assert_eq!(calls.get(), 1, "同 recipe 必须命中缓存");

    // 改 recipe → 必须重新渲染
    inputs.recipe = Some(serde_json::json!({"adjustments": {"exposure": 1.25}}));
    let b = ensure_preview(&src_path, &root, inputs.clone(), render).unwrap();
    assert_eq!(calls.get(), 2, "recipe 变了必须重新渲染");
    assert_ne!(b, a, "不同 recipe 必须落到不同缓存文件");

    // 契约核对：`render.preview` **不接受** recipe 参数（真实 sidecar 实测
    // 'unknown argument(s) for render.preview: recipe'），所以 recipe 由调用方
    // 先 edit.apply 写进 .lumen 工程，渲染只带 path/size/output。
    let captured = seen.borrow().clone().expect("渲染闭包至少应被调用一次");
    assert!(
        captured.get("recipe").is_none(),
        "render.preview 不接受 recipe 键（会把整个渲染打挂）: {:?}",
        captured
    );
    assert_eq!(captured["size"], 1600);
    let _ = std::fs::remove_dir_all(&root);
}

}
