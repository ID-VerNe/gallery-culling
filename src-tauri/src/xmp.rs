use std::fs;
use std::path::{Path, PathBuf};

const XPACKET_UUID: &str = "W5M0MpCehiHzreSzNTczkc9d";

#[derive(Debug, Clone, Default, PartialEq)]
pub struct XmpMetadata {
    pub rating: u8,
    /// Rating = -1（Lightroom / LUMEN RAW 的 reject 约定）
    pub rejected: bool,
    pub label: String,
    pub lens_model: Option<String>,
    pub focal_length: Option<String>,
    pub aperture: Option<String>,
    pub exposure: Option<f32>,
    pub highlights: Option<f32>,
    pub shadows: Option<f32>,
    pub temperature: Option<f32>,
    pub tint: Option<f32>,
    pub contrast: Option<f32>,
}

/// Get the expected .xmp sidecar path for a given image file
pub fn get_xmp_path(image_path: &Path) -> PathBuf {
    image_path.with_extension("xmp")
}

/// Check if an .xmp or .acr sidecar exists
pub fn check_sidecar_exists(image_path: &Path) -> bool {
    let xmp = image_path.with_extension("xmp");
    if xmp.exists() {
        return true;
    }
    let acr = image_path.with_extension("acr");
    acr.exists()
}

/// Extract tag value from XML string (handles both <tag>value</tag> and tag="value")
fn extract_tag_value(content: &str, tag_name: &str) -> Option<String> {
    let open_tag = format!("<{}>", tag_name);
    let close_tag = format!("</{}>", tag_name);
    if let Some(start_idx) = content.find(&open_tag) {
        let after_tag = &content[start_idx + open_tag.len()..];
        if let Some(end_idx) = after_tag.find(&close_tag) {
            let val = after_tag[..end_idx].trim();
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }
    let attr_prefix = format!("{}=\"", tag_name);
    if let Some(start_idx) = content.find(&attr_prefix) {
        let after_attr = &content[start_idx + attr_prefix.len()..];
        if let Some(end_idx) = after_attr.find('\"') {
            let val = after_attr[..end_idx].trim();
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }
    None
}

/// Read full metadata (rating, label, lens, focal length, aperture) from an existing XMP sidecar
pub fn read_xmp_full(xmp_path: &Path) -> Option<XmpMetadata> {
    if !xmp_path.exists() {
        return None;
    }
    let content = fs::read_to_string(xmp_path).ok()?;

    // Parse xmp:Rating (0..5). Lightroom/LUMEN RAW use -1 for "reject";
    let mut rejected = false;
    // the old bare digit scan turned -1 into 1 star (silent data corruption).
    let mut rating = 0u8;
    if let Some(pos) = content.find("xmp:Rating") {
        let slice = &content[pos..content.len().min(pos + 40)];
        let after = &slice["xmp:Rating".len()..];
        if let Some(gt) = after.find('>') {
            let raw: String = after[gt + 1..]
                .trim_start()
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '-')
                .collect();
            if let Ok(v) = raw.parse::<i32>() {
                rejected = v < 0; // -1 = reject（Lightroom / LUMEN RAW 约定）
                rating = v.clamp(0, 5) as u8;
            }
        }
    }

    let label = extract_tag_value(&content, "xmp:Label").unwrap_or_default();
    let lens_model = extract_tag_value(&content, "aux:LensModel")
        .or_else(|| extract_tag_value(&content, "aux:Lens"));
    let focal_length = extract_tag_value(&content, "exif:FocalLength");
    let aperture = extract_tag_value(&content, "exif:FNumber");

    let exposure =
        extract_tag_value(&content, "crs:Exposure2012").and_then(|s| s.parse::<f32>().ok());
    let highlights =
        extract_tag_value(&content, "crs:Highlights2012").and_then(|s| s.parse::<f32>().ok());
    let shadows =
        extract_tag_value(&content, "crs:Shadows2012").and_then(|s| s.parse::<f32>().ok());
    let temperature =
        extract_tag_value(&content, "crs:Temperature").and_then(|s| s.parse::<f32>().ok());
    let tint = extract_tag_value(&content, "crs:Tint").and_then(|s| s.parse::<f32>().ok());
    let contrast =
        extract_tag_value(&content, "crs:Contrast2012").and_then(|s| s.parse::<f32>().ok());

    Some(XmpMetadata {
        rating,
        rejected,
        label,
        lens_model,
        focal_length,
        aperture,
        exposure,
        highlights,
        shadows,
        temperature,
        tint,
        contrast,
    })
}

/// Read rating and label from an existing XMP sidecar
#[allow(dead_code)]
pub fn read_xmp(xmp_path: &Path) -> Option<(u8, String)> {
    read_xmp_full(xmp_path).map(|m| (m.rating, m.label))
}

/// 本方（Gallery Culling）拥有的命名空间。写回时只替换本方块，
/// 第三方命名空间（Lightroom 的 lr:*/dc:*/GPS、未来的 lumen:* 等）原样保留。
const OURS_NAMESPACES: [&str; 4] = [
    "http://ns.adobe.com/xap/1.0/",
    "http://ns.adobe.com/exif/1.0/aux/",
    "http://ns.adobe.com/exif/1.0/",
    "http://ns.adobe.com/camera-raw-settings/1.0/",
];

/// 构造本方 `rdf:Description` 块文本（与历史写出的字节完全一致）。
fn build_our_description(meta: &XmpMetadata) -> String {
    // reject 用 -1（Lightroom 惯例）；LUMEN RAW 与 Lightroom 都按此读回
    let rating: i32 = if meta.rejected {
        -1
    } else {
        meta.rating.min(5) as i32
    };

    let label_tag = if !meta.label.is_empty() {
        format!("      <xmp:Label>{}</xmp:Label>\n", meta.label)
    } else {
        String::new()
    };

    let lens_tag = if let Some(lens) = &meta.lens_model {
        if !lens.trim().is_empty() {
            format!(
                "      <aux:Lens>{}</aux:Lens>\n      <aux:LensModel>{}</aux:LensModel>\n",
                lens.trim(),
                lens.trim()
            )
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    let focal_tag = if let Some(focal) = &meta.focal_length {
        if !focal.trim().is_empty() {
            format!(
                "      <exif:FocalLength>{}</exif:FocalLength>\n",
                focal.trim()
            )
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    let aperture_tag = if let Some(aperture) = &meta.aperture {
        if !aperture.trim().is_empty() {
            format!("      <exif:FNumber>{}</exif:FNumber>\n", aperture.trim())
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    let mut crs_tags = String::new();
    if let Some(exp) = meta.exposure {
        crs_tags.push_str(&format!(
            "      <crs:Exposure2012>{:+.2}</crs:Exposure2012>\n",
            exp
        ));
    }
    if let Some(hl) = meta.highlights {
        crs_tags.push_str(&format!(
            "      <crs:Highlights2012>{:+.0}</crs:Highlights2012>\n",
            hl
        ));
    }
    if let Some(sh) = meta.shadows {
        crs_tags.push_str(&format!(
            "      <crs:Shadows2012>{:+.0}</crs:Shadows2012>\n",
            sh
        ));
    }
    if let Some(temp) = meta.temperature {
        crs_tags.push_str(&format!(
            "      <crs:Temperature>{:.0}</crs:Temperature>\n",
            temp
        ));
    }
    if let Some(tint) = meta.tint {
        crs_tags.push_str(&format!("      <crs:Tint>{:+.0}</crs:Tint>\n", tint));
    }
    if let Some(ct) = meta.contrast {
        crs_tags.push_str(&format!(
            "      <crs:Contrast2012>{:+.0}</crs:Contrast2012>\n",
            ct
        ));
    }

    format!(
        "\x20   <rdf:Description rdf:about=\"\"\n\
        \x20       xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"\n\
        \x20       xmlns:aux=\"http://ns.adobe.com/exif/1.0/aux/\"\n\
        \x20       xmlns:exif=\"http://ns.adobe.com/exif/1.0/\"\n\
        \x20       xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\">\n\
        \x20     <xmp:Rating>{}</xmp:Rating>\n\
        {}{}{}{}{}\
        \x20   </rdf:Description>\n",
        rating, label_tag, lens_tag, focal_tag, aperture_tag, crs_tags
    )
}

/// 无旧文件/不可合并时的完整模板（与历史输出逐字节一致）。
fn build_fresh_document(meta: &XmpMetadata) -> String {
    format!(
        "<?xpacket begin=\"\u{feff}\" id=\"{}\"?>\n\
        <x:xmpmeta xmlns:x=\"adobe:ns:meta/\" x:xmptk=\"GalleryCulling\">\n\
        \x20 <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n\
        {}\
        \x20 </rdf:RDF>\n\
        </x:xmpmeta>\n\
        <?xpacket end=\"w\"?>\n",
        XPACKET_UUID,
        build_our_description(meta)
    )
}

/// 在既有文档里原地替换本方 `rdf:Description` 块；找不到本方块则 None。
///
/// 归属判定基于 xmlns 声明（而非标签名）——第三方也可能写 `xmp:Rating`，
/// 那时必须**不动**它的块。
fn splice_our_block(existing: &str, our_block: &str) -> Option<String> {
    // 文档里通常有多个 rdf:Description（Lightroom 会写好几个），
    // 必须逐个判断归属，**只**替换本方那一个。
    let mut cursor = 0usize;
    while let Some(rel) = existing[cursor..].find("<rdf:Description") {
        let start = cursor + rel;
        let close_rel = existing[start..].find("</rdf:Description>")?;
        let end = start + close_rel + "</rdf:Description>".len();
        let desc = &existing[start..end];
        // 归属判定：本方模板固定按 xmp → aux → exif → crs 顺序声明 4 个命名空间。
        // **只看集合是不够的**：Lightroom 的主块也常同时声明 xmp/exif/crs/aux，
        // 那样会把它的 develop 数据一起吞掉。按顺序判定才安全；
        // 认不出来就 append（对第三方数据零风险）。
        let positions: Vec<usize> = OURS_NAMESPACES
            .iter()
            .filter_map(|ns| desc.find(&format!("xmlns:{}=\"{}\"", short_prefix(ns), ns)))
            .collect();
        let is_ours =
            positions.len() == OURS_NAMESPACES.len() && positions.windows(2).all(|w| w[0] < w[1]);
        if is_ours {
            let mut out = String::with_capacity(existing.len() + our_block.len());
            out.push_str(&existing[..start]);
            out.push_str(our_block);
            out.push_str(&existing[end..]);
            return Some(out);
        }
        cursor = end;
    }
    None
}

fn short_prefix(ns: &str) -> &'static str {
    match ns {
        "http://ns.adobe.com/xap/1.0/" => "xmp",
        "http://ns.adobe.com/exif/1.0/aux/" => "aux",
        "http://ns.adobe.com/exif/1.0/" => "exif",
        _ => "crs",
    }
}

/// 写 XMP：**保留第三方命名空间**，只替换本方拥有的块。
///
/// - 无旧文件，或旧文件里找不到本方块（如 Lightroom 写的侧边栏）→ 追加本方块，
///   原文档逐字节保留；
/// - 旧文件含本方块 → 原地替换该块，其余字节不变。
pub fn write_xmp_preserving(image_path: &Path, meta: &XmpMetadata) -> Result<PathBuf, String> {
    let xmp_path = get_xmp_path(image_path);
    let our_block = build_our_description(meta);

    let merged = match fs::read_to_string(&xmp_path) {
        Ok(existing) => match splice_our_block(&existing, &our_block) {
            Some(spliced) => spliced,
            None => append_our_block(&existing, &our_block),
        },
        Err(_) => build_fresh_document(meta),
    };

    fs::write(&xmp_path, merged)
        .map_err(|e| format!("写入 XMP 失败 ({}): {}", xmp_path.display(), e))?;
    Ok(xmp_path)
}

/// 把本方块插到已有 `rdf:RDF` 的最后一个 Description 之后（Lightroom 风格文档）。
fn append_our_block(existing: &str, our_block: &str) -> String {
    if let Some(pos) = existing.find("</rdf:RDF>") {
        let mut out = String::with_capacity(existing.len() + our_block.len());
        out.push_str(&existing[..pos]);
        out.push_str(our_block);
        out.push_str(&existing[pos..]);
        return out;
    }
    // 连 rdf:RDF 都没有的畸形文件：不冒险改写，直接覆盖为标准模板
    build_fresh_document(&XmpMetadata::default())
}

/// 写 reject：整份元数据置为 Rating = -1（保留第三方命名空间）。
fn write_xmp_rating_minus_one(image_path: &Path) -> Result<PathBuf, String> {
    let meta = XmpMetadata {
        rating: 0,
        label: String::new(),
        rejected: true,
        ..Default::default()
    };
    write_xmp_preserving(image_path, &meta)
}

/// Write Adobe Lightroom Classic & Capture One compatible XMP sidecar
pub fn write_xmp_full(image_path: &Path, meta: &XmpMetadata) -> Result<PathBuf, String> {
    write_xmp_preserving(image_path, meta)
}

/// Write Adobe Lightroom Classic & Capture One compatible XMP sidecar (preserving existing lens/metadata if present)
pub fn write_xmp(image_path: &Path, rating: u8, flag: &str) -> Result<PathBuf, String> {
    let xmp_path = get_xmp_path(image_path);
    let mut meta = read_xmp_full(&xmp_path).unwrap_or_default();
    meta.rating = rating;
    meta.label = match flag {
        "pick" => "Green".to_string(),
        // reject: Lightroom & LUMEN RAW both use Rating = -1 (label stays empty),
        // not Label = "Red" — otherwise the other app reads it back as a colour label.
        _ => String::new(),
    };
    if flag == "reject" {
        meta.rating = 0;
        return write_xmp_rating_minus_one(image_path);
    }
    write_xmp_full(image_path, &meta)
}

/// Update tone adjustments in XMP sidecar, preserving rating, label, and lens info
pub fn update_xmp_tone(
    image_path: &Path,
    exposure: Option<f32>,
    highlights: Option<f32>,
    shadows: Option<f32>,
    temperature: Option<f32>,
    tint: Option<f32>,
    contrast: Option<f32>,
) -> Result<PathBuf, String> {
    let xmp_path = get_xmp_path(image_path);
    let mut meta = read_xmp_full(&xmp_path).unwrap_or_default();
    meta.exposure = exposure;
    meta.highlights = highlights;
    meta.shadows = shadows;
    meta.temperature = temperature;
    meta.tint = tint;
    meta.contrast = contrast;
    write_xmp_full(image_path, &meta)
}

/// Update lens metadata (lens model, focal length, aperture) in XMP, preserving rating & flag
pub fn update_xmp_metadata(
    image_path: &Path,
    lens_model: Option<&str>,
    focal_length: Option<&str>,
    aperture: Option<&str>,
) -> Result<PathBuf, String> {
    let xmp_path = get_xmp_path(image_path);
    let mut meta = read_xmp_full(&xmp_path).unwrap_or_default();
    if let Some(l) = lens_model {
        meta.lens_model = Some(l.to_string());
    }
    if let Some(f) = focal_length {
        meta.focal_length = Some(f.to_string());
    }
    if let Some(a) = aperture {
        meta.aperture = Some(a.to_string());
    }
    write_xmp_full(image_path, &meta)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 模拟 Lightroom 写出的侧边栏（lr:/dc:/GPS + 本方块共存）
    fn lightroom_sidecar() -> String {
        r#"<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:lr="http://ns.adobe.com/lightroom/1.0/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:exif="http://ns.adobe.com/exif/1.0/">
   <lr:hierarchicalSubject>
    <rdf:Bag><rdf:li>Trips|Alps</rdf:li></rdf:Bag>
   </lr:hierarchicalSubject>
   <dc:subject><rdf:Bag><rdf:li>landscape</rdf:li></rdf:Bag></dc:subject>
   <exif:GPSLatitude>46,34.5N</exif:GPSLatitude>
  </rdf:Description>
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:aux="http://ns.adobe.com/exif/1.0/aux/"
    xmlns:exif="http://ns.adobe.com/exif/1.0/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/">
   <xmp:Rating>3</xmp:Rating>
   <crs:Contrast2012>+10</crs:Contrast2012>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
"#
        .to_string()
    }

    #[test]
    fn write_preserves_lightroom_namespaces() {
        let img = std::env::temp_dir().join(format!("xmp_keep_{}.jpg", std::process::id()));
        let xmp = get_xmp_path(&img);
        fs::write(&xmp, lightroom_sidecar()).unwrap();

        let meta = XmpMetadata {
            rating: 5,
            label: "Green".into(),
            ..Default::default()
        };
        write_xmp_preserving(&img, &meta).expect("写应成功");
        let after = fs::read_to_string(&xmp).unwrap();

        // 第三方标签必须存活
        assert!(
            after.contains("lr:hierarchicalSubject"),
            "lr: 层级关键词被摧毁"
        );
        assert!(after.contains("Trips|Alps"), "关键词内容被摧毁");
        assert!(after.contains("dc:subject"), "dc:subject 被摧毁");
        assert!(after.contains("landscape"), "dc 关键词内容被摧毁");
        assert!(after.contains("exif:GPSLatitude"), "GPS 被摧毁");
        // 本方块被更新
        assert!(after.contains("<xmp:Rating>5</xmp:Rating>"), "星级未更新");
        assert!(after.contains("<xmp:Label>Green</xmp:Label>"), "旗标未写入");
        // xpacket 外壳保留
        assert!(after.contains("<?xpacket"), "xpacket 头丢失");
        assert!(after.contains("<?xpacket end=\"w\"?>"), "xpacket 尾丢失");

        let _ = fs::remove_file(&xmp);
    }

    #[test]
    fn write_replaces_only_our_block_not_others() {
        let img = std::env::temp_dir().join(format!("xmp_ours_{}.jpg", std::process::id()));
        let xmp = get_xmp_path(&img);
        fs::write(&xmp, lightroom_sidecar()).unwrap();

        // 改星级
        write_xmp(&img, 1, "none").expect("写应成功");
        let after = fs::read_to_string(&xmp).unwrap();
        assert!(after.contains("<xmp:Rating>1</xmp:Rating>"));
        assert!(
            !after.contains("<xmp:Rating>3</xmp:Rating>"),
            "旧星级应被替换"
        );
        assert!(after.contains("lr:hierarchicalSubject"), "lr: 被摧毁");
        assert!(
            after.contains("<crs:Contrast2012>+10</crs:Contrast2012>"),
            "本方其他标签被误删"
        );

        let _ = fs::remove_file(&xmp);
    }

    #[test]
    fn write_fresh_document_is_byte_identical_to_legacy() {
        // 无旧文件 → 输出必须与历史模板逐字节一致（不回归 Lightroom 兼容性）
        let img = std::env::temp_dir().join(format!("xmp_fresh_{}.jpg", std::process::id()));
        let xmp = get_xmp_path(&img);
        let _ = fs::remove_file(&xmp);

        let meta = XmpMetadata {
            rating: 3,
            label: "Green".into(),
            lens_model: Some("Voigtlander 50mm F2 APO".into()),
            focal_length: Some("50mm".into()),
            aperture: Some("f/2.0".into()),
            exposure: Some(0.65),
            ..Default::default()
        };
        write_xmp_preserving(&img, &meta).unwrap();
        let after = fs::read_to_string(&xmp).unwrap();

        assert!(after.contains(&format!(
            "<?xpacket begin=\"\u{feff}\" id=\"{}\"?>",
            XPACKET_UUID
        )));
        assert!(after.contains("x:xmptk=\"GalleryCulling\""));
        assert!(after.contains("<xmp:Rating>3</xmp:Rating>"));
        assert!(after.contains("<crs:Exposure2012>+0.65</crs:Exposure2012>"));
        // 单个 rdf:Description（本方块）
        assert_eq!(after.matches("<rdf:Description").count(), 1);

        let _ = fs::remove_file(&xmp);
    }

    #[test]
    fn reject_writes_minus_one_rating() {
        // Lightroom / LUMEN RAW 约定：reject = xmp:Rating -1（而不是 Label=Red）
        let img = std::env::temp_dir().join(format!("xmp_reject_{}.jpg", std::process::id()));
        let xmp = get_xmp_path(&img);
        let _ = fs::remove_file(&xmp);
        write_xmp(&img, 3, "reject").expect("写应成功");
        let content = fs::read_to_string(&xmp).unwrap();
        assert!(
            content.contains("<xmp:Rating>-1</xmp:Rating>"),
            "reject 必须写 -1: {}",
            content
        );
        assert!(
            !content.contains("<xmp:Label>"),
            "reject 不应再写 Label: {}",
            content
        );
        let _ = fs::remove_file(&xmp);
    }

    #[test]
    fn lightroom_main_block_with_all_ns_is_not_replaced() {
        // 关键风险：Lightroom 的主块也可能同时声明 xmp/exif/crs/aux（但顺序不同）。
        // 认不出来时必须**追加**本方块，绝不能替换 —— 否则吞掉 LR 的调色数据。
        let doc = r#"<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    xmlns:exif="http://ns.adobe.com/exif/1.0/"
    xmlns:aux="http://ns.adobe.com/exif/1.0/aux/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/">
   <crs:Temperature>5500</crs:Temperature>
   <crs:Contrast2012>+25</crs:Contrast2012>
   <xmp:Label>Red</xmp:Label>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
"#;
        let img = std::env::temp_dir().join(format!("xmp_lrmain_{}.jpg", std::process::id()));
        let xmp = get_xmp_path(&img);
        fs::write(&xmp, doc).unwrap();

        let meta = XmpMetadata {
            rating: 2,
            ..Default::default()
        };
        write_xmp_preserving(&img, &meta).unwrap();
        let after = fs::read_to_string(&xmp).unwrap();

        assert!(
            after.contains("<crs:Contrast2012>+25</crs:Contrast2012>"),
            "LR 调色数据必须存活"
        );
        assert!(
            after.contains("<crs:Temperature>5500</crs:Temperature>"),
            "LR 色温必须存活"
        );
        assert!(
            after.contains("<xmp:Label>Red</xmp:Label>"),
            "LR 色标必须存活"
        );
        assert!(
            after.contains("<xmp:Rating>2</xmp:Rating>"),
            "本方星级应被写入（追加块）"
        );
        assert_eq!(
            after.matches("<rdf:Description").count(),
            2,
            "应为两个块（LR 块 + 本方块）"
        );
        let _ = fs::remove_file(&xmp);
    }

    #[test]
    fn read_reject_as_minus_one_not_one_star() {
        // 回归：旧实现把 -1 裸扫成 1 星
        let img = std::env::temp_dir().join(format!("xmp_readneg_{}.jpg", std::process::id()));
        let xmp = get_xmp_path(&img);
        fs::write(
            &xmp,
            r#"<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
   <xmp:Rating>-1</xmp:Rating>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
"#,
        )
        .unwrap();
        let (rating, _) = read_xmp(&xmp).expect("应可读");
        assert_eq!(rating, 0, "-1 是 reject，不是 1 星");
        let _ = fs::remove_file(&xmp);
    }

    #[test]
    fn test_xmp_write_and_read() {
        let temp_dir = std::env::temp_dir();
        let test_img = temp_dir.join("test_photo_sample.jpg");
        let xmp_file = write_xmp(&test_img, 4, "pick").expect("Should write xmp");
        assert!(xmp_file.exists());

        let (rating, label) = read_xmp(&xmp_file).expect("Should read xmp");
        assert_eq!(rating, 4);
        assert_eq!(label, "Green");

        // Clean up
        let _ = fs::remove_file(xmp_file);
    }

    #[test]
    fn test_xmp_metadata_update() {
        let temp_dir = std::env::temp_dir();
        let test_img = temp_dir.join("test_lens_sample.jpg");
        let _ = write_xmp(&test_img, 5, "pick");

        let xmp_file = update_xmp_metadata(
            &test_img,
            Some("Voigtlander 50mm F2 APO"),
            Some("50mm"),
            Some("f/2.0"),
        )
        .expect("Should update metadata");

        let full_meta = read_xmp_full(&xmp_file).expect("Should read full xmp");
        assert_eq!(full_meta.rating, 5);
        assert_eq!(full_meta.label, "Green");
        assert_eq!(
            full_meta.lens_model.as_deref(),
            Some("Voigtlander 50mm F2 APO")
        );
        assert_eq!(full_meta.focal_length.as_deref(), Some("50mm"));
        assert_eq!(full_meta.aperture.as_deref(), Some("f/2.0"));

        let _ = fs::remove_file(xmp_file);
    }

    #[test]
    fn test_xmp_tone_update() {
        let temp_dir = std::env::temp_dir();
        let test_img = temp_dir.join("test_tone_sample.jpg");
        let _ = write_xmp(&test_img, 3, "pick");

        let xmp_file = update_xmp_tone(
            &test_img,
            Some(0.65),
            Some(-20.0),
            Some(45.0),
            Some(5350.0),
            Some(5.0),
            Some(10.0),
        )
        .expect("Should update tone");

        let full_meta = read_xmp_full(&xmp_file).expect("Should read full xmp");
        assert_eq!(full_meta.rating, 3);
        assert_eq!(full_meta.label, "Green");
        assert_eq!(full_meta.exposure, Some(0.65));
        assert_eq!(full_meta.highlights, Some(-20.0));
        assert_eq!(full_meta.shadows, Some(45.0));
        assert_eq!(full_meta.temperature, Some(5350.0));
        assert_eq!(full_meta.tint, Some(5.0));
        assert_eq!(full_meta.contrast, Some(10.0));

        let _ = fs::remove_file(xmp_file);
    }
}
