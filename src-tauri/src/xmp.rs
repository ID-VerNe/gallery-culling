use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const XPACKET_UUID: &str = "W5M0MpCehiHzreSzNTczkc9d";

/// 临时文件名的进程内自增序号：保证并发写同一图片时每个线程持有**各自**的
/// 临时文件（避免互相 clobber），同时后缀仍不会匹配 `get_xmp_path` / sidecar 规则。
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

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
    let temperature = extract_tag_value(&content, "crs:Temperature2012")
        .and_then(|s| s.parse::<f32>().ok())
        .or_else(|| {
            // 回退旧标签时只接受已经在滑杆量程内的值：历史宿主写下的绝对色温
            // （5350/5500）不是滑杆值，灌进去等于复现那个 bug。
            extract_tag_value(&content, "crs:Temperature")
                .and_then(|s| s.parse::<f32>().ok())
                .filter(|v| (-100.0..=100.0).contains(v))
        });
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

/// 本方模板**从不**声明的第三方命名空间前缀。
///
/// 旧模板（只有 xmp → aux → exif 三个核心命名空间）的护栏：认到顺序一致还不够，
/// 还得确认它没夹带第三方命名空间——否则可能吞掉 Lightroom 的 develop 数据。
/// 两个模板都不含下列前缀，命中即判第三方块（保持追加，对第三方零风险）。
const FOREIGN_NS_PREFIXES: [&str; 9] = [
    "xmlns:lr=",
    "xmlns:dc=",
    "xmlns:xmpRights=",
    "xmlns:tiff=",
    "xmlns:photoshop=",
    "xmlns:Iptc4xmpCore=",
    "xmlns:stEvt=",
    "xmlns:stRef=",
    "xmlns:xmpMM=",
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
        // Temperature2012 = ±100 相对偏移（与调色滑杆、lumen adjustments 同单位）。
        // 旧代码写 crs:Temperature，那是**绝对 Kelvin**：+30 会被 Lightroom 读成 30K。
        crs_tags.push_str(&format!(
            "      <crs:Temperature2012>{:+.0}</crs:Temperature2012>
",
            temp.clamp(-100.0, 100.0)
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

        // 归属判定基于 xmlns 声明（而非标签名）——第三方也可能写 `xmp:Rating`，
        // 那时必须**不动**它的块。
        //
        // 本方模板固定按 xmp → aux → exif → crs 顺序声明。**只看集合是不够的**：
        // Lightroom 的主块也常同时声明 xmp/exif/crs/aux，那样会把它的 develop 数据
        // 一起吞掉。按顺序判定才安全；认不出来就 append（对第三方数据零风险）。
        let ns_at = |i: usize| -> Option<usize> {
            let ns = OURS_NAMESPACES[i];
            desc.find(&format!("xmlns:{}=\"{}\"", short_prefix(ns), ns))
        };
        let xmp = ns_at(0);
        let aux = ns_at(1);
        let exif = ns_at(2);
        let crs = ns_at(3);

        let is_ours = match (xmp, aux, exif, crs) {
            // 当前模板：xmp → aux → exif → crs
            (Some(a), Some(b), Some(c), Some(d)) => a < b && b < c && c < d,
            // 旧模板（crs 尚未引入）：xmp → aux → exif，且不得夹带第三方命名空间
            (Some(a), Some(b), Some(c), None) => {
                a < b && b < c && !FOREIGN_NS_PREFIXES.iter().any(|p| desc.contains(p))
            }
            // 命名空间齐全但顺序不符，或缺少中间某个 → 一律当第三方，追加而非替换
            _ => false,
        };

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
            // 畸形文档：拒写并把原因往上传，绝不降级成"重建空模板"。
            None => append_our_block(&existing, &our_block)?,
        },
        Err(_) => build_fresh_document(meta),
    };

    // 原子写：写同目录临时文件 → rename 覆盖最终名。
    // 直接 `fs::write(xmp_path, …)` 是「截断后写」，并发调用会让两个写入交错，
    // 产出被截断/半写的侧边栏。rename 是原子的：读者要么看到旧内容、要么看到
    // 完整新内容，永不会看到半个文件。
    // 临时名用 `.xmp.tmp<pid>_<seq>` 后缀：既不会被 `get_xmp_path`（`with_extension("xmp")`）
    // 或 `check_sidecar_exists`（查 `.xmp`/`.acr`）误认成照片 sidecar，也不会在多线程
    // 并发时互相覆盖。
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = xmp_path.with_extension(format!("xmp.tmp{}_{}", std::process::id(), seq));
    if let Err(e) = fs::write(&tmp, &merged) {
        let _ = fs::remove_file(&tmp); // 尽力清理残留
        return Err(format!("写入 XMP 失败 ({}): {}", xmp_path.display(), e));
    }
    if let Err(e) = fs::rename(&tmp, &xmp_path) {
        let _ = fs::remove_file(&tmp); // 尽力清理残留
        return Err(format!("写入 XMP 失败 ({}): {}", xmp_path.display(), e));
    }
    Ok(xmp_path)
}

/// 把本方块插到已有 `rdf:RDF` 的最后一个 Description 之后（Lightroom 风格文档）。
///
/// 找不到 `</rdf:RDF>` 说明文件畸形（被截断或被别的工具写坏）。此时**必须报错拒写**：
/// 任何"重建模板"的兜底都会连同调用方已读出的 meta 一起丢弃，把用户已有的
/// 镜头/调色/第三方命名空间整体替换成空模板，且静默返回成功。
fn append_our_block(existing: &str, our_block: &str) -> Result<String, String> {
    let pos = existing.find("</rdf:RDF>").ok_or_else(|| {
        "malformed XMP: 未找到 </rdf:RDF> 闭合标记，拒绝改写（否则会清空整份元数据）"
            .to_string()
    })?;
    let mut out = String::with_capacity(existing.len() + our_block.len());
    out.push_str(&existing[..pos]);
    out.push_str(our_block);
    out.push_str(&existing[pos..]);
    Ok(out)
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
        // 复用上面已读出的 meta，**不要**另造空壳：reject 只是把评级归零，
        // 镜头/调色/第三方命名空间都必须原样存活。原实现走
        // write_xmp_rating_minus_one（XmpMetadata::default()），每次 reject
        // 都会静默清空用户已写好的镜头与调色参数，且不可恢复。
        meta.rating = 0;
        meta.label = String::new();
        meta.rejected = true;
        return write_xmp_preserving(image_path, &meta);
    }
    // 非 reject 分支必须显式清掉 `rejected`。
    //
    // `read_xmp_full` 见到 Rating=-1 会把 `rejected` 置真，而
    // `build_our_description` 只看 `rejected`、不看 `rating`：
    // 不清就会把 -1 原样写回去，**淘汰状态一旦落盘就再也解除不掉**
    // （界面显示 0 星，磁盘仍是 -1，Lightroom 里也仍是"已淘汰"）。
    // 调用方已经用 `flag` 显式声明了旗标意图，这里以它为准。
    meta.rejected = false;
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

/// 唯一的 flag 映射：XMP → 宿主 flag。
///
/// - `Rating = -1` → reject（Lightroom / LUMEN RAW 约定，优先于 Label）
/// - `Label = Green` → pick（宿主历史约定；客体把 Green 读作色标，此处保持兼容）
/// - `Label = Red` → reject（兼容宿主旧文件）
pub fn flag_from_xmp(meta: &XmpMetadata) -> String {
    if meta.rejected {
        return "reject".to_string();
    }
    match meta.label.as_str() {
        "Green" => "pick".to_string(),
        "Red" => "reject".to_string(),
        _ => "none".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------------------------------------------------------------------
    // BE-01：reject 不得清空本方块里已有的镜头与调色元数据
    //
    // 缺陷：write_xmp 的 reject 分支读了 meta（含 lens/tone），却调用
    // write_xmp_rating_minus_one，后者构造全新的 XmpMetadata::default()
    // 空壳，于是每次 reject 都静默清空用户已写好的镜头型号与调色参数。
    // ---------------------------------------------------------------------
    #[test]
    fn rejecting_a_toned_photo_preserves_lens_and_tone() {
        let img =
            std::env::temp_dir().join(format!("xmp_reject_keeps_{}.jpg", std::process::id()));
        let xmp = get_xmp_path(&img);

        // 先写一张"调过色、有镜头信息"的侧边栏
        let seeded = XmpMetadata {
            rating: 4,
            label: String::new(),
            rejected: false,
            lens_model: Some("RF 24-70mm F2.8".into()),
            focal_length: Some("50mm".into()),
            aperture: Some("f/2.8".into()),
            exposure: Some(0.65),
            highlights: Some(-20.0),
            shadows: Some(15.0),
            temperature: Some(8.0),
            tint: Some(-3.0),
            contrast: Some(12.0),
        };
        write_xmp_preserving(&img, &seeded).expect("预置侧边栏应成功");

        // 对它执行 reject —— 修复前 lens/tone 会被清空
        write_xmp(&img, 0, "reject").expect("reject 应成功");

        let after = read_xmp_full(&xmp).expect("侧边栏应仍可读");
        assert!(after.rejected, "reject 状态未落盘");
        assert_eq!(after.rating, 0, "reject 后本方星级应为 0");
        // 关键断言：镜头与调色必须完好
        assert_eq!(
            after.lens_model.as_deref(),
            Some("RF 24-70mm F2.8"),
            "reject 清空了镜头型号（数据丢失）"
        );
        assert_eq!(after.focal_length.as_deref(), Some("50mm"), "reject 清空了焦距");
        assert_eq!(after.aperture.as_deref(), Some("f/2.8"), "reject 清空了光圈");
        assert_eq!(after.exposure, Some(0.65), "reject 清空了曝光");
        assert_eq!(after.highlights, Some(-20.0), "reject 清空了高光");
        assert_eq!(after.shadows, Some(15.0), "reject 清空了阴影");
        assert_eq!(after.temperature, Some(8.0), "reject 清空了色温");
        assert_eq!(after.tint, Some(-3.0), "reject 清空了色调");
        assert_eq!(after.contrast, Some(12.0), "reject 清空了对比度");

        let _ = fs::remove_file(&xmp);
    }

    // ---------------------------------------------------------------------
    // BE-02：畸形 XMP（缺 </rdf:RDF>）必须报错拒写，而不是清空覆盖
    //
    // 缺陷：append_our_block 找不到 </rdf:RDF> 时静默回退到
    // build_fresh_document(&XmpMetadata::default())，**连调用方已读出的 meta
    // 也一并丢弃**，把整个文件替换成空模板并返回 Ok。
    // ---------------------------------------------------------------------
    #[test]
    fn malformed_xmp_refuses_to_overwrite_and_leaves_bytes_untouched() {
        let img = std::env::temp_dir().join(format!("xmp_malformed_{}.jpg", std::process::id()));
        let xmp = get_xmp_path(&img);

        // 有 <rdf:RDF> 但没有 </rdf:RDF>（截断/被别的工具写坏），内含镜头信息
        let malformed = r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:aux="http://ns.adobe.com/exif/1.0/aux/">
   <aux:Lens>RF 24-70mm F2.8</aux:Lens>
  </rdf:Description>
"#;
        fs::write(&xmp, malformed).unwrap();
        let before = fs::read(&xmp).unwrap();

        let meta = XmpMetadata {
            rating: 5,
            label: "Green".into(),
            ..Default::default()
        };
        let result = write_xmp_preserving(&img, &meta);

        assert!(
            result.is_err(),
            "畸形 XMP 必须拒写（返回 Err），修复前会静默覆盖为空模板"
        );
        assert_eq!(
            fs::read(&xmp).unwrap(),
            before,
            "拒写后原文件字节必须完全不变"
        );

        let _ = fs::remove_file(&xmp);
    }

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

    /// 旧模板侧边栏：只有 xmp → aux → exif 三个命名空间（`crs` 尚未引入时写出的）。
    const LEGACY_XMP: &str = concat!(
        "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n",
        "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\" x:xmptk=\"GalleryCulling\">\n",
        "  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n",
        "    <rdf:Description rdf:about=\"\"\n",
        "        xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"\n",
        "        xmlns:aux=\"http://ns.adobe.com/exif/1.0/aux/\"\n",
        "        xmlns:exif=\"http://ns.adobe.com/exif/1.0/\">\n",
        "      <xmp:Rating>1</xmp:Rating>\n",
        "    </rdf:Description>\n",
        "  </rdf:RDF>\n",
        "</x:xmpmeta>\n",
        "<?xpacket end=\"w\"?>\n",
    );

    /// P0-1 回归护栏：淘汰（-1）落盘后，清除/重新打分必须能覆盖它。
    ///
    /// 缺陷：`read_xmp_full` 见到 -1 会置 `rejected`，而 `write_xmp` 非 reject
    /// 分支不清它 → `build_our_description` 永远输出 -1，淘汰状态无法解除。
    #[test]
    fn clearing_a_rejected_photo_writes_zero_not_minus_one() {
        let img = std::env::temp_dir().join(format!("xmp_clear_reject_{}.jpg", std::process::id()));
        let xmp = get_xmp_path(&img);
        let _ = fs::remove_file(&xmp);

        write_xmp(&img, 0, "reject").expect("写 reject 应成功");
        assert!(fs::read_to_string(&xmp).unwrap().contains("<xmp:Rating>-1</xmp:Rating>"));

        // 按 0 / U 清除 → 必须是 0，不能还是 -1
        write_xmp(&img, 0, "none").expect("清除应成功");
        let after = fs::read_to_string(&xmp).unwrap();
        assert!(
            after.contains("<xmp:Rating>0</xmp:Rating>"),
            "淘汰后按 0 必须写 0 而不是 -1: {}",
            after
        );

        // 被淘汰的照片重新打分 → 必须能覆盖 -1
        write_xmp(&img, 5, "none").expect("重打分应成功");
        let after = fs::read_to_string(&xmp).unwrap();
        assert!(
            after.contains("<xmp:Rating>5</xmp:Rating>"),
            "淘汰后打 5 星必须能覆盖 -1: {}",
            after
        );

        let _ = fs::remove_file(&xmp);
    }

    /// P0-2 回归护栏：旧模板（3 命名空间）必须被**原地替换**，而不是追加重复块。
    ///
    /// 缺陷：`splice_our_block` 要求 4 个命名空间齐全 → 旧块被判成第三方 →
    /// 每次写入都追加一个 `rdf:Description`，同文件出现两个冲突的 `xmp:Rating`，
    /// 读侧取先出现的那个，用户新打的星级静默回退。
    #[test]
    fn legacy_three_namespace_block_is_replaced_in_place() {
        let img = std::env::temp_dir().join(format!("xmp_legacy_ns_{}.jpg", std::process::id()));
        let xmp = get_xmp_path(&img);
        fs::write(&xmp, LEGACY_XMP).unwrap();

        write_xmp(&img, 5, "pick").expect("写应成功");
        let after = fs::read_to_string(&xmp).unwrap();

        assert_eq!(
            after.matches("<rdf:Description").count(),
            1,
            "旧模板必须原地替换，不得追加重复块: {}",
            after
        );
        assert_eq!(
            after.matches("<xmp:Rating>").count(),
            1,
            "同文件不得有两个冲突的 xmp:Rating: {}",
            after
        );
        assert!(after.contains("<xmp:Rating>5</xmp:Rating>"), "新值未写入");
        assert!(after.contains("<xmp:Label>Green</xmp:Label>"), "旗标未写入");

        // 再读回来必须是 5（而不是陈旧的 1）
        assert_eq!(read_xmp_full(&xmp).unwrap().rating, 5, "回读必须是新星级");

        let _ = fs::remove_file(&xmp);
    }

    /// P0-2 的护栏之二：放宽到 3 命名空间后，仍不得吞掉第三方块。
    ///
    /// 构造一个"顺序恰好是 xmp→aux→exif、但夹带 lr:/dc:"的块（Lightroom 风格），
    /// 必须判成第三方 → 追加而非替换。
    #[test]
    fn legacy_match_still_refuses_third_party_block() {
        let third_party = concat!(
            "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n",
            "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n",
            "  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n",
            "    <rdf:Description rdf:about=\"\"\n",
            "        xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"\n",
            "        xmlns:aux=\"http://ns.adobe.com/exif/1.0/aux/\"\n",
            "        xmlns:exif=\"http://ns.adobe.com/exif/1.0/\"\n",
            "        xmlns:lr=\"http://ns.adobe.com/lightroom/1.0/\"\n",
            "        xmlns:dc=\"http://purl.org/dc/elements/1.1/\">\n",
            "      <xmp:Rating>2</xmp:Rating>\n",
            "      <lr:hierarchicalSubject>keep-me</lr:hierarchicalSubject>\n",
            "    </rdf:Description>\n",
            "  </rdf:RDF>\n",
            "</x:xmpmeta>\n",
            "<?xpacket end=\"w\"?>\n",
        );
        let img = std::env::temp_dir().join(format!("xmp_thirdparty_{}.jpg", std::process::id()));
        let xmp = get_xmp_path(&img);
        fs::write(&xmp, third_party).unwrap();

        write_xmp(&img, 4, "none").expect("写应成功");
        let after = fs::read_to_string(&xmp).unwrap();

        assert_eq!(
            after.matches("<rdf:Description").count(),
            2,
            "第三方块必须保留（追加而非替换）: {}",
            after
        );
        assert!(
            after.contains("keep-me"),
            "第三方内容不得丢失: {}",
            after
        );

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
    fn xmp_writes_temperature2012_not_absolute() {
        // 回归：滑杆是 ±100 相对偏移，却写进 crs:Temperature（Lightroom 当绝对 Kelvin 读，
        // +30 → 30K → 通蓝废片）。正确标签是 crs:Temperature2012（与滑杆/lumen 同单位）。
        let img = std::env::temp_dir().join(format!("xmp_t2012_{}.jpg", std::process::id()));
        let xmp = get_xmp_path(&img);
        let _ = fs::remove_file(&xmp);
        update_xmp_tone(
            &img,
            Some(0.0),
            Some(0.0),
            Some(0.0),
            Some(30.0),
            Some(0.0),
            Some(0.0),
        )
        .expect("写调色应成功");
        let content = fs::read_to_string(&xmp).unwrap();
        assert!(
            content.contains("<crs:Temperature2012>+30</crs:Temperature2012>"),
            "必须写 Temperature2012: {}",
            content
        );
        assert!(
            !content.contains("<crs:Temperature>"),
            "不能再写绝对色温 crs:Temperature: {}",
            content
        );
        let _ = fs::remove_file(&xmp);
    }

    #[test]
    fn read_prefers_2012_over_legacy_absolute() {
        // 同一份侧边栏里两种标签都在（历史文件被宿主写坏过）：以 2012 为准
        let img = std::env::temp_dir().join(format!("xmp_both_{}.jpg", std::process::id()));
        let xmp = get_xmp_path(&img);
        fs::write(
            &xmp,
            r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:aux="http://ns.adobe.com/exif/1.0/aux/"
    xmlns:exif="http://ns.adobe.com/exif/1.0/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/">
   <xmp:Rating>0</xmp:Rating>
   <crs:Temperature>30</crs:Temperature>
   <crs:Temperature2012>-15</crs:Temperature2012>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
"#,
        )
        .unwrap();
        let m = read_xmp_full(&xmp).expect("应可读");
        assert_eq!(m.temperature, Some(-15.0), "2012 优先于旧绝对标签");
        let _ = fs::remove_file(&xmp);
    }

    #[test]
    fn legacy_absolute_temperature_does_not_pollute_slider() {
        // 历史宿主写的绝对色温（5350/5500）不能灌进 ±100 的滑杆
        let img = std::env::temp_dir().join(format!("xmp_abs_{}.jpg", std::process::id()));
        let xmp = get_xmp_path(&img);
        fs::write(
            &xmp,
            r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:aux="http://ns.adobe.com/exif/1.0/aux/"
    xmlns:exif="http://ns.adobe.com/exif/1.0/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/">
   <xmp:Rating>0</xmp:Rating>
   <crs:Temperature>5350</crs:Temperature>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
"#,
        )
        .unwrap();
        let m = read_xmp_full(&xmp).expect("应可读");
        assert_eq!(
            m.temperature, None,
            "绝对色温不该进滑杆（历史 bug 产物）；None = 滑杆 0"
        );
        let _ = fs::remove_file(&xmp);
    }

    #[test]
    fn tone_temperature_roundtrips_within_slider_range() {
        // 写 → 读 闭环：±100 相对偏移必须原样回来
        for t in [-100.0f32, -15.0, 0.0, 30.0, 100.0] {
            let img = std::env::temp_dir().join(format!(
                "xmp_trt_{}_{}.jpg",
                std::process::id(),
                t.to_string().replace('.', "_")
            ));
            let xmp = get_xmp_path(&img);
            let _ = fs::remove_file(&xmp);
            update_xmp_tone(
                &img,
                Some(0.0),
                Some(0.0),
                Some(0.0),
                Some(t),
                Some(0.0),
                Some(0.0),
            )
            .unwrap();
            let back = read_xmp_full(&xmp).expect("应可读");
            assert_eq!(back.temperature, Some(t), "temperature 闭环失败: {}", t);
            let _ = fs::remove_file(&xmp);
        }
    }

    #[test]
    fn flag_mapping_matrix() {
        // Rating=-1 → reject（优先于 Label）
        assert_eq!(
            flag_from_xmp(&XmpMetadata {
                rating: 0,
                rejected: true,
                label: "Green".into(),
                ..Default::default()
            }),
            "reject"
        );
        // Label=Green → pick（宿主历史约定）
        assert_eq!(
            flag_from_xmp(&XmpMetadata {
                rating: 3,
                label: "Green".into(),
                ..Default::default()
            }),
            "pick"
        );
        // Label=Red → reject（旧文件兼容）
        assert_eq!(
            flag_from_xmp(&XmpMetadata {
                rating: 0,
                label: "Red".into(),
                ..Default::default()
            }),
            "reject"
        );
        // 其余（含 LUMEN RAW 的其它色标）→ none
        assert_eq!(
            flag_from_xmp(&XmpMetadata {
                rating: 2,
                label: "Blue".into(),
                ..Default::default()
            }),
            "none"
        );
        assert_eq!(
            flag_from_xmp(&XmpMetadata {
                rating: 4,
                ..Default::default()
            }),
            "none"
        );
    }

    #[test]
    fn roundtrip_rating_flag_through_sidecar() {
        // 写 → 读 闭环：pick/reject/none 都必须原样回来
        for (rating, flag) in [(3u8, "pick"), (0u8, "reject"), (5u8, "none"), (1u8, "none")] {
            let img = std::env::temp_dir().join(format!(
                "xmp_rt_{}_{}_{}.jpg",
                std::process::id(),
                rating,
                flag
            ));
            let xmp = get_xmp_path(&img);
            let _ = fs::remove_file(&xmp);
            write_xmp(&img, rating, flag).expect("写应成功");
            let back = read_xmp_full(&xmp).expect("读应成功");
            assert_eq!(
                flag_from_xmp(&back),
                flag,
                "flag 闭环失败: rating={} flag={} → {:?}",
                rating,
                flag,
                back
            );
            if flag != "reject" {
                assert_eq!(back.rating, rating, "rating 闭环失败");
            }
            let _ = fs::remove_file(&xmp);
        }
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

        // 契约修正：色温滑杆是 ±100 相对偏移，旧测试传 5350（绝对 Kelvin）并断言
        // 原样读回 —— 那正是把 30K 当 +30 写进 Lightroom 的历史 bug。现在写入夹紧
        // 到 +100 并落到 crs:Temperature2012。
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

        let written = fs::read_to_string(&xmp_file).unwrap();
        assert!(
            written.contains("<crs:Temperature2012>+100</crs:Temperature2012>"),
            "5350 应夹紧到 +100 并写 2012: {}",
            written
        );

        let full_meta = read_xmp_full(&xmp_file).expect("Should read full xmp");
        assert_eq!(full_meta.rating, 3);
        assert_eq!(full_meta.label, "Green");
        assert_eq!(full_meta.exposure, Some(0.65));
        assert_eq!(full_meta.highlights, Some(-20.0));
        assert_eq!(full_meta.shadows, Some(45.0));
        assert_eq!(full_meta.temperature, Some(100.0), "夹紧后读回 +100");
        assert_eq!(full_meta.tint, Some(5.0));
        assert_eq!(full_meta.contrast, Some(10.0));

        let _ = fs::remove_file(xmp_file);
    }

    #[test]
    fn concurrent_writes_never_produce_truncated_xmp() {
        // 回归：旧的 `fs::write(&xmp_path, merged)` 是截断后写，并发调用会交错
        // 产出半写/截断的侧边栏。原子写（tmp → rename）后必须始终是完整文件。
        let img = std::env::temp_dir().join(format!("xmp_concurrent_{}.jpg", std::process::id()));
        let xmp = get_xmp_path(&img);
        let _ = fs::remove_file(&xmp);

        // 先写一份合法侧边栏，保证并发开始前文件存在
        write_xmp(&img, 1, "none").expect("初始写应成功");

        let mut handles = Vec::new();
        for i in 0..8u8 {
            let img = img.clone();
            handles.push(std::thread::spawn(move || {
                let _ = write_xmp(&img, (i % 5) + 1, "none");
            }));
        }
        for h in handles {
            h.join().expect("并发写线程不应 panic");
        }

        // 内容必须仍可解析，且以 xpacket 尾正常收尾 —— 不存在半写/截断。
        let meta = read_xmp_full(&xmp).expect("并发写后侧边栏必须仍可解析");
        assert!(meta.rating <= 5, "rating 应在 0..=5: {}", meta.rating);
        let content = fs::read_to_string(&xmp).unwrap();
        assert!(
            content.contains("<?xpacket end=\"w\"?>"),
            "侧边栏必须以 xpacket 尾正常收尾（不得半写）: {}",
            content
        );
        assert!(
            content.contains("<xmp:Rating>"),
            "侧边栏必须含本方块: {}",
            content
        );

        let _ = fs::remove_file(&xmp);
    }
}
