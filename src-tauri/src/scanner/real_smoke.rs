//! 真实相册冒烟（手动运行，不进 CI）。
//!
//! 合成测试只能证明「逻辑对」，证明不了「真机文件读得对」：相机 RAW 的
//! EXIF 方向、内嵌预览、厂商字段、旧版 `Label=Green` 遗留，只有真文件覆盖得到。
//!
//! ```text
//! GALLERY_REAL_RAW_DIR="C:\path\to\sandbox" GALLERY_REAL_ALBUM_DIR="C:\path\to\album"
//!   cargo test --lib real_album_smoke -- --ignored --nocapture
//! ```
//!
//! 沙箱约定：`<dir>/pairs`（ARW+JPG+XMP 成对）与 `<dir>/rawonly`（只有 ARW）。
//! `GALLERY_REAL_ALBUM_DIR` 为可选的整本相册**只读**扫描（绝不写 `.gallerycull.json`）。

use super::*;
use std::time::Instant;

/// 真实相册冒烟：用**真实相机 RAW**（不是合成占位文件）验证
/// 分组 / RAW-only / 旗标存储 / XMP 不被改写的完整链路。
///
/// 为什么值得留：合成测试只能证明「逻辑对」，证明不了「真机文件读得对」。
/// 相机 RAW 的 EXIF 方向、内嵌预览、厂商字段都只有真文件才覆盖得到。
#[test]
#[ignore = "需要真实素材：设置 GALLERY_REAL_RAW_DIR 后加 --ignored 运行"]
fn real_album_smoke() {
    let Ok(root) = std::env::var("GALLERY_REAL_RAW_DIR") else {
        println!("[real_album] 未设置 GALLERY_REAL_RAW_DIR，跳过");
        return;
    };
    let root = std::path::PathBuf::from(root);
    let pairs = root.join("pairs");
    let rawonly = root.join("rawonly");
    assert!(pairs.is_dir(), "缺少 pairs 目录: {}", pairs.display());

    let cancel = AtomicBool::new(false);

    // ---- 1. 成对目录：分组、评级、has_xmp ----
    // 真实用法：JPG 与 RAW 常在同一目录，两个设置都指向它。
    let t0 = Instant::now();
    let res = scan_folders(
        pairs.to_str().unwrap(),
        Some(pairs.to_str().unwrap()),
        "filename",
        &cancel,
        |_, _, _| {},
    )
    .expect("成对目录扫描应成功");
    let scan_ms = t0.elapsed().as_secs_f64() * 1000.0;
    println!(
        "[real_album] pairs: {} 组 / {:.0} ms（{:.1} ms/组）",
        res.total_count,
        scan_ms,
        scan_ms / res.total_count.max(1) as f64
    );

    assert!(res.total_count >= 5, "成对目录应至少 5 组");
    for g in &res.groups {
        assert!(g.jpg.is_some(), "{} 应识别到 JPG", g.base_name);
        assert!(g.raw.is_some(), "{} 应识别到 RAW", g.base_name);
        assert!(!g.id.is_empty(), "{} 缺少 id", g.base_name);
        println!(
            "[real_album]   {} rating={} flag={} has_xmp={}",
            g.base_name, g.rating, g.flag, g.has_xmp
        );
    }
    // 真实相册里这三张预先写好了评级，必须原样读回（证明 XMP 解析对真文件有效）
    for (name, want) in [("DSC04337", 1u8), ("DSC04338", 1u8), ("DSC04477", 5u8)] {
        if let Some(g) = res.groups.iter().find(|g| g.base_name.eq_ignore_ascii_case(name)) {
            assert_eq!(g.rating, want, "{} 的评级应读回 {}", name, want);
        }
    }

    // ---- 2. RAW-only 目录：无 JPG 也必须成组 ----
    if rawonly.is_dir() {
        let res = scan_folders(
            rawonly.to_str().unwrap(),
            Some(rawonly.to_str().unwrap()),
            "filename",
            &cancel,
            |_, _, _| {},
        )
        .expect("RAW-only 目录扫描应成功");
        assert!(res.total_count >= 3, "RAW-only 目录应至少 3 组");
        for g in &res.groups {
            assert!(g.raw.is_some(), "{} 应识别到 RAW", g.base_name);
            assert!(g.jpg.is_none(), "{} 不该有 JPG", g.base_name);
        }
        println!("[real_album] rawonly: {} 组，全部无 JPG", res.total_count);
    }

    // ---- 3. 旗标存储：真实旧文件（Label=Green）→ none → pick ----
    // 必须先清掉 store：否则上一次运行留下的条目会让「回落旧约定」断言失真。
    let store_file = cullstore::store_path(&pairs);
    let _ = fs::remove_file(&store_file);

    // 挑一张**真的带旧约定**的文件（XMP 里 Label=Green），这是迁移风险的正中央。
    let legacy = res.groups.iter().find(|g| {
        read_xmp_full(&get_xmp_path(&pairs.join(format!("{}.ARW", g.base_name))))
            .map(|m| m.label == "Green")
            .unwrap_or(false)
    });
    let probe = legacy
        .map(|g| g.base_name.clone())
        .unwrap_or_else(|| res.groups[0].base_name.clone());
    let has_legacy = legacy.is_some();
    println!(
        "[real_album] 旗标探针: {}（XMP 含 Label=Green: {}）",
        probe, has_legacy
    );

    let xmp_path = get_xmp_path(&pairs.join(format!("{}.ARW", probe)));
    let xmp_before = fs::read(&xmp_path).ok();

    // 3a. 无 store 条目：旧 Green 必须仍读成 pick（老用户不会一升级就丢选片）
    let scan = || {
        scan_folders(
            pairs.to_str().unwrap(),
            Some(pairs.to_str().unwrap()),
            "filename",
            &cancel,
            |_, _, _| {},
        )
        .expect("重扫应成功")
    };
    let g = scan();
    let before_flag = g.groups.iter().find(|g| g.base_name == probe).unwrap().flag.clone();
    if has_legacy {
        assert_eq!(before_flag, "pick", "旧 Label=Green 应回落读成 pick");
    }

    // 3b. 写 none：必须压住旧 Green（否则留用状态永远清不掉）
    cullstore::upsert(&pairs, &probe, "none").expect("清旗标应成功");
    let g = scan();
    assert_eq!(
        g.groups.iter().find(|g| g.base_name == probe).unwrap().flag,
        "none",
        "写 none 后必须真的清掉（旧 Label=Green 不得复活）"
    );

    // 3c. 再写 pick：store 条目优先于旧约定
    cullstore::upsert(&pairs, &probe, "pick").expect("写 pick 应成功");
    let g = scan();
    assert_eq!(
        g.groups.iter().find(|g| g.base_name == probe).unwrap().flag,
        "pick",
        "store 条目应为唯一真值"
    );

    // ---- 4. XMP 不得因旗标变化而被改写 ----
    let xmp_after = fs::read(&xmp_path).ok();
    assert_eq!(
        xmp_before, xmp_after,
        "旗标写入不得改动 XMP 字节（pick 已不再写 xmp:Label）"
    );
    if has_legacy {
        let text = String::from_utf8_lossy(xmp_after.as_deref().unwrap_or(b""));
        assert!(
            text.contains("<xmp:Label>Green</xmp:Label>"),
            "旧 Green 必须原样留在盘上（只读兼容，不擦除）"
        );
    }
    println!("[real_album] 旗标 roundtrip OK，XMP 字节未变（{}）", probe);

    // ---- 5. 整本相册只读扫描（可选）：规模与配对完整性 ----
    // 只读：绝不写 .gallerycull.json 到用户相册。
    if let Ok(album) = std::env::var("GALLERY_REAL_ALBUM_DIR") {
        let album = std::path::PathBuf::from(album);
        if album.is_dir() {
            let t0 = Instant::now();
            let res = scan_folders(
                album.to_str().unwrap(),
                Some(album.to_str().unwrap()),
                "time_filename",
                &cancel,
                |_, _, _| {},
            )
            .expect("整本相册扫描应成功");
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            let mut paired = 0;
            let mut jpg_only = 0;
            let mut raw_only = 0;
            for g in &res.groups {
                match (g.jpg.is_some(), g.raw.is_some()) {
                    (true, true) => paired += 1,
                    (true, false) => jpg_only += 1,
                    (false, true) => raw_only += 1,
                    (false, false) => panic!("{} 既无 JPG 也无 RAW", g.base_name),
                }
            }
            println!(
                "[real_album] 整本相册: {} 组 / {:.0} ms（{:.2} ms/组）· 配对 {} / 仅JPG {} / 仅RAW {}",
                res.total_count, ms, ms / res.total_count.max(1) as f64, paired, jpg_only, raw_only
            );
            assert!(
                !cullstore::store_path(&album).exists(),
                "只读扫描不得创建 .gallerycull.json"
            );
        }
    }
}
