//! 宿主调色参数与 lumen recipe 的互转 + recipe 内容哈希。
//!
//! recipe_hash 必须对 JSON 键排序后再摘要（canonical_json），否则同一份
//! recipe 因键序不同会算出不同哈希，缓存条目白白分裂。

use serde_json::Value;
use sha2::{Digest, Sha256};

/// 宿主 ToneAdjustments → lumen recipe changes（**最终值**语义）。
///
/// 六个滑杆全部直通，包括 temperature。Step 9 当时排除了 temperature，理由是
/// "量纲不同"——实测证明真正量纲不同的是**宿主写 XMP 的标签**（`crs:Temperature`
/// 是绝对 Kelvin），而不是 lumen：宿主滑杆量程 -100..=100（"冷暖偏移"），
/// lumen `adjustments.temperature` 同为 ±100 相对偏移（实测传 500 → 存 100），
/// 两侧现在都落到 `crs:Temperature2012`（Lightroom 的相对刻度）。
pub fn tone_to_recipe(tone: &crate::models::ToneAdjustments, include_temperature: bool) -> Value {
    let mut adj = serde_json::Map::new();
    adj.insert("exposure".into(), json_f32(tone.exposure));
    adj.insert("highlights".into(), json_f32(tone.highlights));
    adj.insert("shadows".into(), json_f32(tone.shadows));
    adj.insert("tint".into(), json_f32(tone.tint));
    adj.insert("contrast".into(), json_f32(tone.contrast));
    // 单位已统一（两侧都是 ±100 相对偏移），默认直通；
    // include_temperature=false 保留只为兼容旧调用点。
    adj.insert(
        "temperature".into(),
        json_f32(tone.temperature.clamp(-100.0, 100.0)),
    );
    if !include_temperature {
        adj.remove("temperature");
    }
    serde_json::json!({ "adjustments": adj })
}

/// lumen `state.adjustments` → 宿主 ToneAdjustments（缺失字段 → 0）。
pub fn recipe_to_tone(state: &Value) -> crate::models::ToneAdjustments {
    let adj = state.get("adjustments").cloned().unwrap_or(Value::Null);
    let g = |k: &str| adj.get(k).and_then(Value::as_f64).unwrap_or(0.0) as f32;
    crate::models::ToneAdjustments {
        exposure: g("exposure"),
        highlights: g("highlights"),
        shadows: g("shadows"),
        // temperature 同量纲问题：回读也只作展示，不参与回写
        // 单位已统一（±100 相对），回读即滑杆值；越界值夹紧以免 UI 失控
        temperature: g("temperature").clamp(-100.0, 100.0),
        tint: g("tint"),
        contrast: g("contrast"),
    }
}

/// f32 → JSON：量化到 4 位小数，消除 f32→f64 的二进制表示噪声
/// （0.65f32 直接转 f64 会得到 0.6499999761581421，破坏快照对比与缓存稳定性）。
pub fn json_f32(v: f32) -> Value {
    let rounded = (v as f64 * 10_000.0).round() / 10_000.0;
    serde_json::Number::from_f64(rounded)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

/// recipe 的规范化哈希（进缓存键）：键排序 + 浮点归一，保证同配方同 key。
pub fn recipe_hash(changes: &Value) -> String {
    let canonical = canonical_json(changes);
    let digest = Sha256::digest(canonical.as_bytes());
    digest
        .iter()
        .take(8)
        .map(|b| format!("{:02x}", b))
        .collect()
}

/// 递归规范化：对象键排序、浮点保留 4 位，避免 0.30000000000000004 之类的抖动。
pub fn canonical_json(v: &Value) -> String {
    match v {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let inner: Vec<String> = keys
                .iter()
                .map(|k| format!("{:?}:{}", k, canonical_json(&map[*k])))
                .collect();
            format!("{{{}}}", inner.join(","))
        }
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(0.0);
            format!("{:.4}", f)
        }
        other => other.to_string(),
    }
}
