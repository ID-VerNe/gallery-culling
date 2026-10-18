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

/// 解析 `xmp:Rating` -> `(是否淘汰, 星级)`。
///
/// **刻意不走 `extract_tag_value`**：那条按"标签缺失/值非数字即 None"处理，
/// 而 Rating 需要区分 `-1`（Lightroom / LUMEN RAW 的 reject 约定）与 `0..5`，
/// 且**不能**把 `-1` 的符号丢掉（旧实现用裸数字扫描，`-1` 被读成 1 星，
/// 是一次静默数据损坏）。
fn parse_rating(content: &str) -> (bool, u8) {
    let Some(pos) = content.find("xmp:Rating") else {
        return (false, 0);
    };
    let slice = &content[pos..content.len().min(pos + 40)];
    let after = &slice["xmp:Rating".len()..];
    let Some(gt) = after.find('>') else {
        return (false, 0);
    };
    let raw: String = after[gt + 1..]
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '-')
        .collect();
    match raw.parse::<i32>() {
        Ok(v) => (v < 0, v.clamp(0, 5) as u8),
        Err(_) => (false, 0),
    }
}

/// 取调色标签并解析为 f32。
///
/// 六个滑杆字段此前各写一遍 `extract_tag_value(...).and_then(|s| s.parse().ok())`。
/// 「标签缺失」与「值不是数字」在这里统一塌成 `None` —— 对调色而言两者等价
/// （都用默认值），分开处理只会让调用点多一个 match。
///
/// 需要区分「有值但超量程」的调用方（见 temperature 的回退）必须自己补 filter。
fn extract_f32(content: &str, tag_name: &str) -> Option<f32> {
    extract_tag_value(content, tag_name).and_then(|s| s.parse::<f32>().ok())
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
    // the old bare digit scan turned -1 into 1 star (silent data corruption).
    let (rejected, rating) = parse_rating(&content);

    let label = extract_tag_value(&content, "xmp:Label").unwrap_or_default();
    let lens_model = extract_tag_value(&content, "aux:LensModel")
        .or_else(|| extract_tag_value(&content, "aux:Lens"));
    let focal_length = extract_tag_value(&content, "exif:FocalLength");
    let aperture = extract_tag_value(&content, "exif:FNumber");

    let exposure = extract_f32(&content, "crs:Exposure2012");
    let highlights = extract_f32(&content, "crs:Highlights2012");
    let shadows = extract_f32(&content, "crs:Shadows2012");
    let tint = extract_f32(&content, "crs:Tint");
    let contrast = extract_f32(&content, "crs:Contrast2012");
    // temperature 单独处理：2012 标签缺失时回退旧标签，且**必须**过滤量程。
    // 历史宿主写下的绝对色温（5350/5500）不是滑杆值，灌进去等于复现那个 bug。
    let temperature = extract_f32(&content, "crs:Temperature2012").or_else(|| {
        extract_f32(&content, "crs:Temperature")
            .filter(|v| (-100.0..=100.0).contains(v))
    });

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

/// 本方（Gallery Culling）拥有的命名空间。
///
/// 这里是这四个 URI 的**唯一真值**：`build_our_description` 生成 xmlns 声明、
/// `splice_our_block` 认本方块，两处都从这里取。此前三处各写一份字面量
/// （含一个 `short_prefix` 反查表），改一处漏两处会让写出的块与认回的块对不上。
/// 反查表随该重复一并删除 —— 有了成对的 (prefix, uri) 就不需要反查。
const OURS_NAMESPACES: [(/* prefix */ &str, /* uri */ &str); 4] = [
    ("xmp", "http://ns.adobe.com/xap/1.0/"),
    ("aux", "http://ns.adobe.com/exif/1.0/aux/"),
    ("exif", "http://ns.adobe.com/exif/1.0/"),
    ("crs", "http://ns.adobe.com/camera-raw-settings/1.0/"),
];

/// 本方块里 `xmlns:xxx="URI"` 声明行（顺序与 `OURS_NAMESPACES` 一致）。
///
/// 缩进与 `\x20` 转义沿用历史输出：写出的字节必须与既有侧边栏逐字节一致，
/// 否则 Lightroom 会把文件当成模板更换，重写 develop 数据。
///
/// ⚠️ 换行必须是 `\n`（真换行），且**最后一条声明要顺带闭合开标签的 `>`**。
/// 见 `namespace_declarations_use_real_newlines_not_literal_backslash_n`。
fn xmlns_declarations() -> String {
    let total = OURS_NAMESPACES.len();
    OURS_NAMESPACES
        .iter()
        .enumerate()
        .map(|(i, (prefix, uri))| {
            // 末条声明以 `>` 收尾，闭合 `<rdf:Description rdf:about=""`
            let closer = if i + 1 == total { ">\n" } else { "\n" };
            format!("        xmlns:{}=\"{}\"{}", prefix, uri, closer)
        })
        .collect()
}

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

/// Lightroom 约定的五色色标。大小写不敏感匹配，写出的永远是这里的大小写。
pub const LABEL_VALUES: [&str; 5] = ["Red", "Yellow", "Green", "Blue", "Purple"];

/// 校验色标取值，返回规范写法。空串表示"无/清除"。
///
/// 只认 Lightroom 的五个英文色名：写别的值 Lightroom 读不出来，等于把用户的
/// 标记藏进一个没人认识的字符串里。前端快捷键与本函数共用这份清单。
pub fn validate_label(label: &str) -> Result<&'static str, String> {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return Ok("");
    }
    LABEL_VALUES
        .iter()
        .find(|v| v.eq_ignore_ascii_case(trimmed))
        .copied()
        .ok_or_else(|| {
            format!(
                "未知的色标值: {}（可选 Red / Yellow / Green / Blue / Purple，或空串清除）",
                trimmed
            )
        })
}

/// 构造本方 `rdf:Description` 块文本（与历史写出的字节完全一致）。
///
/// `write_label = false` 用于「本方块之外已经有一份 `xmp:Label`」的情形：
/// `xmp:Label` 是单值属性，两边各写一份等于同一属性两个值，读谁取决于实现细节。
fn build_our_description(meta: &XmpMetadata, write_label: bool) -> String {
    // reject 用 -1（Lightroom 惯例）；LUMEN RAW 与 Lightroom 都按此读回
    let rating: i32 = if meta.rejected {
        -1
    } else {
        meta.rating.min(5) as i32
    };

    let label_tag = if write_label && !meta.label.is_empty() {
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
        {}\x20     <xmp:Rating>{}</xmp:Rating>\n\
        {}{}{}{}{}\
        \x20   </rdf:Description>\n",
        xmlns_declarations(),
        rating, label_tag, lens_tag, focal_tag, aperture_tag, crs_tags
    )
}

/// 无旧文件/不可合并时的完整模板（与历史输出逐字节一致）。
fn build_fresh_document(meta: &XmpMetadata, write_label: bool) -> String {
    format!(
        "<?xpacket begin=\"\u{feff}\" id=\"{}\"?>\n\
        <x:xmpmeta xmlns:x=\"adobe:ns:meta/\" x:xmptk=\"GalleryCulling\">\n\
        \x20 <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n\
        {}\
        \x20 </rdf:RDF>\n\
        </x:xmpmeta>\n\
        <?xpacket end=\"w\"?>\n",
        XPACKET_UUID,
        build_our_description(meta, write_label)
    )
}

/// 判断一个 `rdf:Description` 块是否本方写出（判定规则见 `splice_our_block`）。
fn is_our_description(desc: &str) -> bool {
    let ns_at = |i: usize| -> Option<usize> {
        let (prefix, uri) = OURS_NAMESPACES[i];
        desc.find(&format!("xmlns:{}=\"{}\"", prefix, uri))
    };
    let xmp = ns_at(0);
    let aux = ns_at(1);
    let exif = ns_at(2);
    let crs = ns_at(3);

    match (xmp, aux, exif, crs) {
        // 当前模板：xmp → aux → exif → crs
        (Some(a), Some(b), Some(c), Some(d)) => a < b && b < c && c < d,
        // 旧模板（crs 尚未引入）：xmp → aux → exif，且不得夹带第三方命名空间
        (Some(a), Some(b), Some(c), None) => {
            a < b && b < c && !FOREIGN_NS_PREFIXES.iter().any(|p| desc.contains(p))
        }
        // 命名空间齐全但顺序不符，或缺少中间某个 → 一律当第三方，追加而非替换
        _ => false,
    }
}

/// 本方 `rdf:Description` 块的字节区间。找不到 → None。
fn find_our_block_range(existing: &str) -> Option<(usize, usize)> {
    let mut cursor = 0usize;
    while let Some(rel) = existing[cursor..].find("<rdf:Description") {
        let start = cursor + rel;
        let close_rel = existing[start..].find("</rdf:Description>")?;
        let end = start + close_rel + "</rdf:Description>".len();
        if is_our_description(&existing[start..end]) {
            return Some((start, end));
        }
        cursor = end;
    }
    None
}

/// `xmp:Label` 的一次出现。既支持元素形式，也支持属性形式。
#[derive(Debug, Clone, Copy)]
struct LabelOccurrence {
    /// 整个元素/属性的区间（清除时删这一段）。
    start: usize,
    end: usize,
    /// 值本身的区间（改值时只换这一段）。
    value_start: usize,
    value_end: usize,
}

/// 找出文档里所有的 `xmp:Label` 出现位置。
///
/// 刻意不做完整 XML 解析：本模块的读写都基于字符串拼接，引入解析器会让「写出的
/// 字节与历史一致」这条不变量无法保证（见 `xmlns_declarations` 的注释）。
fn find_label_occurrences(doc: &str) -> Vec<LabelOccurrence> {
    let mut out = Vec::new();
    const OPEN: &str = "<xmp:Label>";
    const CLOSE: &str = "</xmp:Label>";
    const ATTR: &str = "xmp:Label=\"";

    // 元素形式
    let mut cursor = 0usize;
    while let Some(rel) = doc[cursor..].find(OPEN) {
        let start = cursor + rel;
        let value_start = start + OPEN.len();
        let Some(close_rel) = doc[value_start..].find(CLOSE) else {
            break;
        };
        let value_end = value_start + close_rel;
        out.push(LabelOccurrence {
            start,
            end: value_end + CLOSE.len(),
            value_start,
            value_end,
        });
        cursor = value_end + CLOSE.len();
    }

    // 属性形式（`xmp:Label="Red"`）：`<xmp:Label>` 不含 `="`，两种形式不会互相误匹配
    let mut cursor = 0usize;
    while let Some(rel) = doc[cursor..].find(ATTR) {
        let attr_start = cursor + rel;
        let value_start = attr_start + ATTR.len();
        let Some(close_rel) = doc[value_start..].find('"') else {
            break;
        };
        let value_end = value_start + close_rel;
        out.push(LabelOccurrence {
            start: attr_start,
            end: value_end + 1,
            value_start,
            value_end,
        });
        cursor = value_end + 1;
    }

    out.sort_by_key(|o| o.start);
    out
}

/// 本方方块之外的第一处 `xmp:Label`。
fn label_outside(doc: &str, our: Option<(usize, usize)>) -> Option<LabelOccurrence> {
    find_label_occurrences(doc)
        .into_iter()
        .find(|o| match our {
            Some((start, end)) => o.start < start || o.end > end,
            None => true,
        })
}

/// 把某一处色标改成 `value`；`value` 为空则整段删除。
fn patch_label(doc: &str, occ: &LabelOccurrence, value: &str) -> String {
    let mut out = String::with_capacity(doc.len() + value.len());
    out.push_str(&doc[..occ.start]);
    if !value.is_empty() {
        out.push_str(&doc[occ.start..occ.value_start]);
        out.push_str(value);
        out.push_str(&doc[occ.value_end..occ.end]);
    }
    out.push_str(&doc[occ.end..]);
    out
}

/// 在既有文档里原地替换本方 `rdf:Description` 块；找不到本方块则 None。
///
/// 归属判定基于 xmlns 声明（而非标签名）——第三方也可能写 `xmp:Rating`，
/// 那时必须**不动**它的块。
fn splice_our_block(existing: &str, our_block: &str) -> Option<String> {
    // 文档里通常有多个 rdf:Description（Lightroom 会写好几个），
    // 必须逐个判断归属，**只**替换本方那一个。归属规则见 `is_our_description`。
    let (start, end) = find_our_block_range(existing)?;
    let mut out = String::with_capacity(existing.len() + our_block.len());
    out.push_str(&existing[..start]);
    out.push_str(our_block);
    out.push_str(&existing[end..]);
    Some(out)
}



/// 写 XMP：**保留第三方命名空间**，只替换本方拥有的块。
///
/// - 无旧文件，或旧文件里找不到本方块（如 Lightroom 写的侧边栏）→ 追加本方块，
///   原文档逐字节保留；
/// - 旧文件含本方块 → 原地替换该块，其余字节不变。
pub fn write_xmp_preserving(image_path: &Path, meta: &XmpMetadata) -> Result<PathBuf, String> {
    let existing = fs::read_to_string(get_xmp_path(image_path)).ok();
    write_meta_with_existing(image_path, meta, existing.as_deref())
}

/// `write_xmp_preserving` 的实际实现：允许调用方传入**已读出的文档**。
///
/// 色标写入需要先就地改掉外部方块里的那唯一一份，再拼本方块 —— 拆成"先写盘、
/// 再读回、再写盘"会多一次落盘，也会在中间态留下两个色标。
fn write_meta_with_existing(
    image_path: &Path,
    meta: &XmpMetadata,
    existing: Option<&str>,
) -> Result<PathBuf, String> {
    let xmp_path = get_xmp_path(image_path);
    // `xmp:Label` 是单值属性：本方块之外已经有一份时，本方块不再写。
    // 否则同一文件里出现两个色标，Lightroom / Bridge 取哪个取决于实现细节。
    let write_label = existing
        .map(|doc| label_outside(doc, find_our_block_range(doc)).is_none())
        .unwrap_or(true);
    let our_block = build_our_description(meta, write_label);

    let merged = match existing {
        Some(doc) => match splice_our_block(doc, &our_block) {
            Some(spliced) => spliced,
            // 畸形文档：拒写并把原因往上传，绝不降级成"重建空模板"。
            None => append_our_block(doc, &our_block)?,
        },
        None => build_fresh_document(meta, write_label),
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

/// read-modify-write 骨架的「read」一半：定位侧边栏 + 读回现状。
///
/// 读不到就用默认值（不是错误）：宿主可以对一张没有侧边栏的照片首次评级，
/// 那时它就是「从零开始写」。
///
/// 另一半的 `write_xmp_preserving` 保持显式调用，不做 `modify_xmp(image, f)`
/// 这类闭包式封装 —— 三处调用的写入时机各不相同（`write_xmp` 的 reject 分支要
/// 中途提前返回另走分支），套进闭包只会把控制流藏起来。
fn read_sidecar(image_path: &Path) -> (PathBuf, XmpMetadata) {
    let xmp_path = get_xmp_path(image_path);
    let meta = read_xmp_full(&xmp_path).unwrap_or_default();
    // 这里**不再**清空"非 Green"的色标。
    //
    // 旧实现清掉它们，是因为 `read_xmp_full` 读的是整份文档：把 Lightroom 方块里
    // 的 `Blue` 原样写进本方块，会在同一文件里造出两个 `xmp:Label`（单值属性）。
    // 现在去重落在写入层（`write_meta_with_existing`：本方块外已有色标时本方块
    // 不写），所以读侧可以如实返回文档里那唯一一份色标，不必靠"猜归属"。
    (xmp_path, meta)
}

/// 撤销前的一致性检查：读回一张照片在 XMP 里的（星级, 是否淘汰, 色标）。
///
/// 只读侧边栏，不碰本地旗标存储 —— 旗标是我们独占写的文件，外部工具改不到它，
/// 真正会被别的程序动过的只有 `xmp:Rating` 与 `xmp:Label`。
///
/// 语义与 `write_xmp` 的入参一一对应，所以调用方可以拿「上次写入的意图」直接比对。
pub fn read_disk_state(image_path: &Path) -> (u8, bool, String) {
    let (_, meta) = read_sidecar(image_path);
    (meta.rating, meta.rejected, meta.label)
}

/// 写评级、淘汰与色标到 XMP 侧边栏。
///
/// 旗标自 2026-10 起由 `cullstore`（每文件夹 `.gallerycull.json`）独立存储，
/// 理由见 `.plan/adr-001-cull-flag-store.md`。`flag` 参数只用来判断淘汰。
///
/// `label` 三态：
/// - `None` —— 不动色标（评级/旗标写入走这条）；
/// - `Some("")` —— 清除色标（两份都不留）；
/// - `Some("Red")` —— 设为该色标（就地改那唯一一份）。
pub fn write_xmp(
    image_path: &Path,
    rating: u8,
    flag: &str,
    label: Option<&str>,
) -> Result<PathBuf, String> {
    // 先验参再读盘：非法色标不该留下任何副作用（包括"读到一半"的临时文件）。
    let label = match label {
        Some(l) => Some(validate_label(l)?),
        None => None,
    };

    let (xmp_path, mut meta) = read_sidecar(image_path);
    meta.rating = rating;
    if flag == "reject" {
        // 复用上面已读出的 meta，**不要**另造空壳：reject 只是把评级归零，
        // 镜头/调色/第三方命名空间都必须原样存活。原实现走
        // write_xmp_rating_minus_one（XmpMetadata::default()），每次 reject
        // 都会静默清空用户已写好的镜头与调色参数，且不可恢复。
        meta.rating = 0;
        meta.rejected = true;
    } else {
        // 非 reject 分支必须显式清掉 `rejected`。
        //
        // `read_xmp_full` 见到 Rating=-1 会把 `rejected` 置真，而
        // `build_our_description` 只看 `rejected`、不看 `rating`：
        // 不清就会把 -1 原样写回去，**淘汰状态一旦落盘就再也解除不掉**
        // （界面显示 0 星，磁盘仍是 -1，Lightroom 里也仍是"已淘汰"）。
        // 调用方已经用 `flag` 显式声明了旗标意图，这里以它为准。
        meta.rejected = false;
    }

    let existing = fs::read_to_string(&xmp_path).ok();
    let Some(value) = label else {
        // 不动色标：写入层会自动去重（外部已有一份时本方块不再写）。
        return write_meta_with_existing(image_path, &meta, existing.as_deref());
    };

    // 设值/清除：文档里若已有色标（通常在 Lightroom 自己的方块里），就地改那一份。
    // 本方块稍后会被整体重建，它原来那份自然消失，不会留下第二份。
    let patched = existing.as_ref().and_then(|doc| {
        let our = find_our_block_range(doc);
        label_outside(doc, our).map(|occ| patch_label(doc, &occ, value))
    });
    meta.label = value.to_string();
    let doc = patched.or(existing);
    write_meta_with_existing(image_path, &meta, doc.as_deref())
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
    let (_xmp_path, mut meta) = read_sidecar(image_path);
    meta.exposure = exposure;
    meta.highlights = highlights;
    meta.shadows = shadows;
    meta.temperature = temperature;
    meta.tint = tint;
    meta.contrast = contrast;
    write_xmp_preserving(image_path, &meta)
}

/// Update lens metadata (lens model, focal length, aperture) in XMP, preserving rating & flag
pub fn update_xmp_metadata(
    image_path: &Path,
    lens_model: Option<&str>,
    focal_length: Option<&str>,
    aperture: Option<&str>,
) -> Result<PathBuf, String> {
    let (_xmp_path, mut meta) = read_sidecar(image_path);
    if let Some(l) = lens_model {
        meta.lens_model = Some(l.to_string());
    }
    if let Some(f) = focal_length {
        meta.focal_length = Some(f.to_string());
    }
    if let Some(a) = aperture {
        meta.aperture = Some(a.to_string());
    }
    write_xmp_preserving(image_path, &meta)
}

/// 旧约定：`xmp:Label` → flag。**只用于读历史文件**。
///
/// 2026-10 之前本应用借 `Label` 存旗标（`Green`=pick、`Red`=reject）。新写入已改由
/// `cullstore` 承担，这里保留只为不让老文件里的标记凭空消失；一旦该照片在本地
/// store 里有条目，条目即覆盖本函数的结果。
pub fn legacy_flag_from_label(label: &str) -> &'static str {
    match label {
        "Green" => "pick",
        "Red" => "reject",
        _ => "none",
    }
}

/// XMP → flag 的兼容映射（**不看**本地 store）。
///
/// - `Rating = -1` → reject（Lightroom / LUMEN RAW 通用约定）
/// - `Label = Green/Red` → 旧约定
///
/// 界面旗标的唯一真值是 `cullstore::resolve_flag`（store 优先、`-1` 最高优先）。
/// 这里只给同步游标、诊断这类"只认 XMP"的场合用。
pub fn flag_from_xmp(meta: &XmpMetadata) -> String {
    if meta.rejected {
        return "reject".to_string();
    }
    legacy_flag_from_label(&meta.label).to_string()
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
        write_xmp(&img, 0, "reject", None).expect("reject 应成功");

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

    /// 一份"Lightroom 写的"侧边栏：色标在它自己的方块里，不属于本应用。
    fn foreign_label_sidecar(label: &str) -> String {
        format!(
            "<?xpacket begin=\"\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n\
             <x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n\
             \x20 <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n\
             \x20  <rdf:Description rdf:about=\"\"\n\
             \x20    xmlns:lr=\"http://ns.adobe.com/lightroom/1.0/\"\n\
             \x20    xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\">\n\
             \x20   <xmp:Label>{}</xmp:Label>\n\
             \x20  </rdf:Description>\n\
             \x20 </rdf:RDF>\n\
             </x:xmpmeta>\n",
            label
        )
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
        assert!(after.contains("<xmp:Label>Green</xmp:Label>"), "色标未写入");
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
        write_xmp(&img, 1, "none", None).expect("写应成功");
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

    /// 命名空间声明行之间必须是**真换行**，不能是字面量 `\n`（反斜杠 + n）。
    ///
    /// 回归：BE-05 的 DRY 抽取把 `xmlns_declarations()` 写成
    /// `format!("...\\n")`，`\\n` 在普通字符串字面量里是**反斜杠+n 两个字符**，
    /// 于是四条声明挤进标签内部，产出**解析器拒绝的 XML**（标签内出现非法 `\`）。
    /// 宿主自带的宽松字符串解析器读得回来，所以快照测试与 126 条 Rust 用例
    /// 全绿；只有真实 XMP 消费方（Lightroom / Capture One / Bridge）会拒绝。
    /// 上面的 `write_fresh_document_is_byte_identical_to_legacy` 名字虽叫
    /// byte-identical，实际只做了若干 `contains`，覆盖不到这一条。
    #[test]
    fn namespace_declarations_use_real_newlines_not_literal_backslash_n() {
        let img = std::env::temp_dir().join(format!("xmp_nl_{}.jpg", std::process::id()));
        let xmp = get_xmp_path(&img);
        let _ = fs::remove_file(&xmp);

        let meta = XmpMetadata { rating: 2, ..Default::default() };
        write_xmp_preserving(&img, &meta).unwrap();
        let after = fs::read_to_string(&xmp).unwrap();

        // 全文不得出现字面量 \n（反斜杠 + n）
        assert!(
            !after.contains("\\n"),
            "写出的 XMP 含字面量 \\n，XML 非法：\n{}",
            after
        );

        // 四条声明各自以真换行收尾，且保持 xmp -> aux -> exif -> crs 顺序
        for (i, (prefix, uri)) in OURS_NAMESPACES.iter().enumerate() {
            // 末条顺带闭合开标签，故期望 `">\n` 而非 `"\n`
            let closer = if i + 1 == OURS_NAMESPACES.len() { ">\n" } else { "\n" };
            assert!(
                after.contains(&format!("        xmlns:{}=\"{}\"{}", prefix, uri, closer)),
                "namespace 声明结尾异常: xmlns:{}",
                prefix
            );
        }

        // 末条声明必须顺带闭合 `<rdf:Description` 开标签
        assert!(
            after.contains(&format!(
                "        xmlns:crs=\"{}\">\n",
                OURS_NAMESPACES[3].1
            )),
            "末条 namespace 声明未闭合 <rdf:Description 开标签：\n{}",
            after
        );

        // rdf:Description 开标签必须真的闭合（引号后紧跟换行/空白，而非反斜杠）
        assert!(
            !after.contains("rdf:about=\"\"\\n"),
            "rdf:Description 开标签被字面量 \\n 截断"
        );

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

        write_xmp(&img, 0, "reject", None).expect("写 reject 应成功");
        assert!(fs::read_to_string(&xmp).unwrap().contains("<xmp:Rating>-1</xmp:Rating>"));

        // 按 0 / U 清除 → 必须是 0，不能还是 -1
        write_xmp(&img, 0, "none", None).expect("清除应成功");
        let after = fs::read_to_string(&xmp).unwrap();
        assert!(
            after.contains("<xmp:Rating>0</xmp:Rating>"),
            "淘汰后按 0 必须写 0 而不是 -1: {}",
            after
        );

        // 被淘汰的照片重新打分 → 必须能覆盖 -1
        write_xmp(&img, 5, "none", None).expect("重打分应成功");
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

        write_xmp(&img, 5, "pick", None).expect("写应成功");
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
        // pick 不再写 Label：旗标已迁到 cullstore，色标字段归还给色标
        assert!(
            !after.contains("<xmp:Label>"),
            "pick 不应再写色标: {}",
            after
        );

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

        write_xmp(&img, 4, "none", None).expect("写应成功");
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
    fn reject_writes_minus_one_rating_and_keeps_colour_label() {
        // Lightroom / LUMEN RAW 约定：reject = xmp:Rating -1（而不是 Label=Red）。
        // 色标在 Lightroom 自己的方块里：不得删，也不得复制一份进本方块。
        let img = std::env::temp_dir().join(format!("xmp_reject_{}.jpg", std::process::id()));
        let xmp = get_xmp_path(&img);
        fs::write(&xmp, foreign_label_sidecar("Blue")).unwrap();

        write_xmp(&img, 3, "reject", None).expect("写应成功");

        let content = fs::read_to_string(&xmp).unwrap();
        assert!(
            content.contains("<xmp:Rating>-1</xmp:Rating>"),
            "reject 必须写 -1: {}",
            content
        );
        assert!(
            content.contains("<xmp:Label>Blue</xmp:Label>"),
            "淘汰不得删除用户的色标: {}",
            content
        );
        assert_eq!(
            content.matches("<xmp:Label>").count(),
            1,
            "不得在同一文件里造出第二个 xmp:Label: {}",
            content
        );
        let _ = fs::remove_file(&xmp);
    }

    #[test]
    fn clearing_flag_keeps_colour_label() {
        // 按 U / 0 清除旗标，同样不得删色标。旧实现走 `_ => String::new()` 直接清空。
        let img = std::env::temp_dir().join(format!("xmp_clear_label_{}.jpg", std::process::id()));
        let xmp = get_xmp_path(&img);
        fs::write(&xmp, foreign_label_sidecar("Red")).unwrap();

        write_xmp(&img, 0, "none", None).expect("清除应成功");

        let content = fs::read_to_string(&xmp).unwrap();
        assert!(
            content.contains("<xmp:Label>Red</xmp:Label>"),
            "清除旗标不得删除用户的色标: {}",
            content
        );
        assert!(
            content.contains("<xmp:Rating>0</xmp:Rating>"),
            "评级应归零: {}",
            content
        );
        let _ = fs::remove_file(&xmp);
    }

    /// 旧文件的 pick 只存在本方块的 `Label=Green` 里。改调色/镜头不得把它抹掉 ——
    /// 否则用户没动过旗标，却在改滑杆时静默丢了「留用」。
    #[test]
    fn legacy_green_pick_survives_tone_update() {
        let img = std::env::temp_dir().join(format!("xmp_legacy_green_{}.jpg", std::process::id()));
        let xmp = get_xmp_path(&img);
        let _ = fs::remove_file(&xmp);

        // 造一份"旧版本写出的"侧边栏：本方块里带 Label=Green
        write_xmp_preserving(
            &img,
            &XmpMetadata {
                rating: 4,
                label: "Green".into(),
                ..Default::default()
            },
        )
        .expect("预置旧文件应成功");

        update_xmp_tone(&img, Some(0.5), Some(0.0), Some(0.0), Some(0.0), Some(0.0), Some(0.0))
            .expect("改调色应成功");

        let content = fs::read_to_string(&xmp).unwrap();
        assert!(
            content.contains("<xmp:Label>Green</xmp:Label>"),
            "改调色不得抹掉旧文件的 pick 标记: {}",
            content
        );
        let meta = read_xmp_full(&xmp).expect("读应成功");
        assert_eq!(flag_from_xmp(&meta), "pick", "旧文件仍须读回 pick");
        assert_eq!(meta.rating, 4);
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
    fn roundtrip_rating_through_sidecar() {
        // 评级闭环：XMP 仍是星级的真值。
        //
        // 旗标的闭环**不在这里**：pick 自 2026-10 起由 cullstore 存
        // （`.gallerycull.json`），写 XMP 只剩淘汰（Rating=-1）。旗标闭环见
        // `cullstore::tests::upsert_then_load_roundtrip`。
        for rating in [0u8, 1, 3, 5] {
            let img = std::env::temp_dir().join(format!(
                "xmp_rt_{}_{}.jpg",
                std::process::id(),
                rating
            ));
            let xmp = get_xmp_path(&img);
            let _ = fs::remove_file(&xmp);
            write_xmp(&img, rating, "none", None).expect("写应成功");
            let back = read_xmp_full(&xmp).expect("读应成功");
            assert_eq!(back.rating, rating, "rating 闭环失败");
            assert_eq!(flag_from_xmp(&back), "none", "未淘汰不该读成旗标");
            let _ = fs::remove_file(&xmp);
        }
    }

    #[test]
    fn reject_roundtrips_as_reject() {
        let img = std::env::temp_dir().join(format!("xmp_rt_reject_{}.jpg", std::process::id()));
        let xmp = get_xmp_path(&img);
        let _ = fs::remove_file(&xmp);
        write_xmp(&img, 0, "reject", None).expect("写应成功");
        let back = read_xmp_full(&xmp).expect("读应成功");
        assert_eq!(flag_from_xmp(&back), "reject", "淘汰必须读回 reject");
        assert!(back.rejected, "Rating=-1 必须置 rejected");
        let _ = fs::remove_file(&xmp);
    }

    #[test]
    fn pick_is_not_encoded_as_colour_label() {
        // 回归护栏：pick 一旦再被写成 Label=Green，Lightroom 的绿标就又变成"留用"，
        // 且按 U 清除时会把用户色标删掉。这条锁住"不写"。
        let img = std::env::temp_dir().join(format!("xmp_pick_nolabel_{}.jpg", std::process::id()));
        let xmp = get_xmp_path(&img);
        let _ = fs::remove_file(&xmp);
        write_xmp(&img, 4, "pick", None).expect("写应成功");
        let content = fs::read_to_string(&xmp).unwrap();
        assert!(
            !content.contains("<xmp:Label>"),
            "pick 不得写色标: {}",
            content
        );
        assert!(content.contains("<xmp:Rating>4</xmp:Rating>"));
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
        let rating = read_xmp_full(&xmp).expect("应可读").rating;
        assert_eq!(rating, 0, "-1 是 reject，不是 1 星");
        let _ = fs::remove_file(&xmp);
    }

    #[test]
    fn test_xmp_write_and_read() {
        let temp_dir = std::env::temp_dir();
        let test_img = temp_dir.join("test_photo_sample.jpg");
        let xmp_file = write_xmp(&test_img, 4, "pick", None).expect("Should write xmp");
        assert!(xmp_file.exists());

        let meta = read_xmp_full(&xmp_file).expect("Should read xmp");
        assert_eq!(meta.rating, 4);
        // pick 不再写色标（旗标已迁到 cullstore）
        assert_eq!(meta.label, "");

        // Clean up
        let _ = fs::remove_file(xmp_file);
    }

    #[test]
    fn test_xmp_metadata_update() {
        let temp_dir = std::env::temp_dir();
        let test_img = temp_dir.join("test_lens_sample.jpg");
        let _ = write_xmp(&test_img, 5, "pick", None);

        let xmp_file = update_xmp_metadata(
            &test_img,
            Some("Voigtlander 50mm F2 APO"),
            Some("50mm"),
            Some("f/2.0"),
        )
        .expect("Should update metadata");

        let full_meta = read_xmp_full(&xmp_file).expect("Should read full xmp");
        assert_eq!(full_meta.rating, 5);
        assert_eq!(full_meta.label, "");
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
        let _ = write_xmp(&test_img, 3, "pick", None);

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
        assert_eq!(full_meta.label, "");
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
        write_xmp(&img, 1, "none", None).expect("初始写应成功");

        let mut handles = Vec::new();
        for i in 0..8u8 {
            let img = img.clone();
            handles.push(std::thread::spawn(move || {
                let _ = write_xmp(&img, (i % 5) + 1, "none", None);
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

    // ---------------------------------------------------------------------
    // FR-02 色标：`xmp:Label` 是**单值属性**，一个文件里只能有一份。
    //
    // Lightroom 会把色标写进它自己的 `rdf:Description`；本应用追加的方块也在
    // 同一个 `rdf:RDF` 里。两边各写一份 = 同一属性两个值，读取方取谁全靠实现
    // 细节。下列用例锁住三条：
    // 1. 本方块外已有色标时，本方块**不再**写色标（否则立刻造出两份）；
    // 2. 用户主动改色标时，就地改那唯一一份，不新增第二份；
    // 3. 清除色标时，两份都不能留（否则清了个寂寞）。
    // ---------------------------------------------------------------------

    /// 带色标的 Lightroom 侧边栏：色标在它自己的方块里，另有需要原样保留的标签。
    fn lightroom_sidecar_with_label(label: &str) -> String {
        format!(
            "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n\
             <x:xmpmeta xmlns:x=\"adobe:ns:meta/\" x:xmptk=\"Adobe XMP Core\">\n\
             \x20 <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n\
             \x20  <rdf:Description rdf:about=\"\"\n\
             \x20    xmlns:lr=\"http://ns.adobe.com/lightroom/1.0/\"\n\
             \x20    xmlns:dc=\"http://purl.org/dc/elements/1.1/\"\n\
             \x20    xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\">\n\
             \x20   <xmp:Label>{}</xmp:Label>\n\
             \x20   <lr:hierarchicalSubject>\n\
             \x20    <rdf:Bag><rdf:li>Trips|Alps</rdf:li></rdf:Bag>\n\
             \x20   </lr:hierarchicalSubject>\n\
             \x20   <dc:subject><rdf:Bag><rdf:li>landscape</rdf:li></rdf:Bag></dc:subject>\n\
             \x20  </rdf:Description>\n\
             \x20 </rdf:RDF>\n\
             </x:xmpmeta>\n\
             <?xpacket end=\"w\"?>\n",
            label
        )
    }

    #[test]
    fn setting_label_writes_exactly_one_label() {
        let img = std::env::temp_dir().join(format!("xmp_label_set_{}.jpg", std::process::id()));
        let xmp = get_xmp_path(&img);
        let _ = fs::remove_file(&xmp);

        write_xmp(&img, 0, "none", Some("Red")).expect("设色标应成功");
        let content = fs::read_to_string(&xmp).unwrap();

        assert_eq!(
            content.matches("<xmp:Label>").count(),
            1,
            "一个文件只能有一份 xmp:Label: {}",
            content
        );
        assert!(content.contains("<xmp:Label>Red</xmp:Label>"), "{}", content);
        assert_eq!(read_xmp_full(&xmp).unwrap().label, "Red");

        let _ = fs::remove_file(&xmp);
    }

    #[test]
    fn setting_label_replaces_foreign_label_in_place() {
        let img = std::env::temp_dir().join(format!("xmp_label_foreign_{}.jpg", std::process::id()));
        let xmp = get_xmp_path(&img);
        fs::write(&xmp, lightroom_sidecar_with_label("Blue")).unwrap();

        write_xmp(&img, 0, "none", Some("Red")).expect("改色标应成功");
        let content = fs::read_to_string(&xmp).unwrap();

        assert_eq!(
            content.matches("<xmp:Label>").count(),
            1,
            "改色标不得造出第二份: {}",
            content
        );
        assert!(content.contains("<xmp:Label>Red</xmp:Label>"), "{}", content);
        assert!(!content.contains("Blue"), "旧色标必须被替换: {}", content);
        // 第三方数据必须逐字保留
        assert!(content.contains("Trips|Alps"), "关键词被摧毁: {}", content);
        assert!(content.contains("landscape"), "dc:subject 被摧毁: {}", content);
        assert_eq!(read_xmp_full(&xmp).unwrap().label, "Red");

        let _ = fs::remove_file(&xmp);
    }

    #[test]
    fn clearing_label_removes_every_occurrence() {
        // 本方块里有一份，清除后必须彻底消失（否则 Lightroom 里还是红的）
        let img = std::env::temp_dir().join(format!("xmp_label_clear_{}.jpg", std::process::id()));
        let xmp = get_xmp_path(&img);
        let _ = fs::remove_file(&xmp);

        write_xmp(&img, 0, "none", Some("Red")).expect("设色标应成功");
        write_xmp(&img, 0, "none", Some("")).expect("清色标应成功");
        let content = fs::read_to_string(&xmp).unwrap();

        assert!(
            !content.contains("<xmp:Label>"),
            "清除后不得残留色标: {}",
            content
        );
        assert_eq!(read_xmp_full(&xmp).unwrap().label, "");

        let _ = fs::remove_file(&xmp);
    }

    #[test]
    fn clearing_foreign_label_keeps_third_party_data() {
        let img = std::env::temp_dir().join(format!("xmp_label_clear_lr_{}.jpg", std::process::id()));
        let xmp = get_xmp_path(&img);
        fs::write(&xmp, lightroom_sidecar_with_label("Blue")).unwrap();

        write_xmp(&img, 0, "none", Some("")).expect("清色标应成功");
        let content = fs::read_to_string(&xmp).unwrap();

        assert!(!content.contains("<xmp:Label>"), "{}", content);
        assert!(content.contains("Trips|Alps"), "{}", content);
        assert!(content.contains("landscape"), "{}", content);

        let _ = fs::remove_file(&xmp);
    }

    #[test]
    fn tone_update_does_not_duplicate_foreign_label() {
        // 改调色时 `read_sidecar` 会把整份文档的色标读进 meta；若原样写进本方块，
        // 就会在同一个文件里出现两个 xmp:Label。去重必须发生在写入层。
        let img = std::env::temp_dir().join(format!("xmp_label_tone_{}.jpg", std::process::id()));
        let xmp = get_xmp_path(&img);
        fs::write(&xmp, lightroom_sidecar_with_label("Blue")).unwrap();

        update_xmp_tone(&img, Some(0.5), Some(0.0), Some(0.0), Some(0.0), Some(0.0), Some(0.0))
            .expect("改调色应成功");
        let content = fs::read_to_string(&xmp).unwrap();

        assert_eq!(
            content.matches("<xmp:Label>").count(),
            1,
            "改调色不得复制色标: {}",
            content
        );
        assert!(content.contains("<xmp:Label>Blue</xmp:Label>"), "{}", content);
        assert!(content.contains("<crs:Exposure2012>+0.50</crs:Exposure2012>"));

        let _ = fs::remove_file(&xmp);
    }

    #[test]
    fn rating_write_without_label_keeps_existing_label() {
        let img = std::env::temp_dir().join(format!("xmp_label_keep_{}.jpg", std::process::id()));
        let xmp = get_xmp_path(&img);
        let _ = fs::remove_file(&xmp);

        write_xmp(&img, 0, "none", Some("Purple")).expect("设色标应成功");
        // label=None 表示"不动色标"
        write_xmp(&img, 5, "pick", None).expect("改评级应成功");

        let content = fs::read_to_string(&xmp).unwrap();
        assert!(content.contains("<xmp:Label>Purple</xmp:Label>"), "{}", content);
        assert!(content.contains("<xmp:Rating>5</xmp:Rating>"), "{}", content);
        assert_eq!(content.matches("<xmp:Label>").count(), 1);

        let _ = fs::remove_file(&xmp);
    }

    #[test]
    fn invalid_label_is_rejected_and_writes_nothing() {
        let img = std::env::temp_dir().join(format!("xmp_label_bad_{}.jpg", std::process::id()));
        let xmp = get_xmp_path(&img);
        let _ = fs::remove_file(&xmp);

        let err = write_xmp(&img, 0, "none", Some("Pink")).expect_err("非法色标必须拒写");
        assert!(err.contains("色标"), "错误信息应说明色标: {}", err);
        assert!(!xmp.exists(), "拒写时不该留下侧边栏");

        let _ = fs::remove_file(&xmp);
    }
}
