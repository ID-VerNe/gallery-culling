//! 撤销前的磁盘一致性检查（FR-04 第二步）。
//!
//! 撤销会**无条件覆盖** XMP 里的评级与色标。如果用户在这期间用 Lightroom /
//! Bridge 改过同一张照片，盲目覆盖就是把别人的修改抹掉 —— 这正是报告 §5.3
//! 「成本/风险」里要求先检查 sidecar 的原因。
//!
//! 检查放在后端而不是前端：`Rating=-1` 与「淘汰」的编码规则在 `xmp.rs` 里
//! 是单一真值，前端不该再复制一份。

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::xmp;

/// 调用方**以为**磁盘上是什么（也就是它上一次写成功的状态）。
#[derive(Debug, Clone, Deserialize)]
pub struct ExpectedCullState {
    pub path: String,
    pub rating: u8,
    pub flag: String,
    pub label: String,
}

/// 一张照片的差异说明。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CullStateMismatch {
    pub path: String,
    /// 人类可读的差异，多项用「；」连接，如「星级：磁盘 3，预期 2」。
    pub detail: String,
}

/// 色标比较前先归一：`red` 与 `Red` 是同一个色标（写入层本身也大小写不敏感）。
fn normalize_label(label: &str) -> String {
    match xmp::validate_label(label) {
        Ok(canonical) => canonical.to_string(),
        Err(_) => label.to_string(),
    }
}

fn label_or_none(label: &str) -> &str {
    if label.is_empty() {
        "无"
    } else {
        label
    }
}

/// 比对「预期」与「磁盘」。一致返回 `None`，不一致返回可读差异。
///
/// 星级与淘汰状态是同一份 `xmp:Rating` 的两种解读，所以**互斥比较**：
/// 淘汰态不一致时只说淘汰，不再单独比星级（否则一条改动会报两遍）。
pub fn describe_mismatch(
    expected: &ExpectedCullState,
    disk_rating: u8,
    disk_rejected: bool,
    disk_label: &str,
) -> Option<String> {
    let expect_rejected = expected.flag == "reject";
    let mut diffs: Vec<String> = Vec::new();

    if disk_rejected != expect_rejected {
        diffs.push(
            if disk_rejected {
                "淘汰状态：磁盘已淘汰，预期未淘汰"
            } else {
                "淘汰状态：磁盘未淘汰，预期已淘汰"
            }
            .to_string(),
        );
    } else if !expect_rejected && disk_rating != expected.rating {
        // 淘汰时星级恒为 0，比较没有意义；只在两边都非淘汰时比星级。
        diffs.push(format!(
            "星级：磁盘 {}，预期 {}",
            disk_rating, expected.rating
        ));
    }

    let disk = normalize_label(disk_label);
    let want = normalize_label(&expected.label);
    if disk != want {
        diffs.push(format!(
            "色标：磁盘「{}」，预期「{}」",
            label_or_none(&disk),
            label_or_none(&want)
        ));
    }

    if diffs.is_empty() {
        None
    } else {
        Some(diffs.join("；"))
    }
}

/// 逐张比对。只有真的不一致的才进结果。
pub fn collect_mismatches(items: Vec<ExpectedCullState>) -> Vec<CullStateMismatch> {
    items
        .into_iter()
        .filter_map(|item| {
            let (rating, rejected, label) = xmp::read_disk_state(Path::new(&item.path));
            describe_mismatch(&item, rating, rejected, &label).map(|detail| CullStateMismatch {
                path: item.path,
                detail,
            })
        })
        .collect()
}

/// 撤销/重做前的检查入口。返回空数组 = 磁盘与我们以为什么一致，可以安全覆盖。
#[tauri::command]
pub fn check_cull_state_cmd(items: Vec<ExpectedCullState>) -> Vec<CullStateMismatch> {
    collect_mismatches(items)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn expected(over: PartialExpected) -> ExpectedCullState {
        ExpectedCullState {
            path: "D:/shoot/IMG_0001.jpg".to_string(),
            rating: over.rating.unwrap_or(0),
            flag: over.flag.unwrap_or("none").to_string(),
            label: over.label.unwrap_or("").to_string(),
        }
    }

    #[derive(Default)]
    struct PartialExpected {
        rating: Option<u8>,
        flag: Option<&'static str>,
        label: Option<&'static str>,
    }

    fn no_mismatch(over: PartialExpected, disk: (u8, bool, &str)) -> bool {
        describe_mismatch(&expected(over), disk.0, disk.1, disk.2).is_none()
    }

    #[test]
    fn identical_state_has_no_mismatch() {
        assert!(no_mismatch(
            PartialExpected {
                rating: Some(3),
                ..Default::default()
            },
            (3, false, "")
        ));
    }

    #[test]
    fn rating_difference_is_reported() {
        let detail = describe_mismatch(
            &expected(PartialExpected {
                rating: Some(2),
                ..Default::default()
            }),
            3,
            false,
            "",
        )
        .expect("星级不同应报差异");
        assert!(detail.contains("星级"), "detail 缺少星级说明: {detail}");
        assert!(detail.contains('3') && detail.contains('2'), "detail 缺少数值: {detail}");
    }

    #[test]
    fn disk_rejected_but_expected_not_is_reported() {
        let detail = describe_mismatch(
            &expected(PartialExpected {
                rating: Some(0),
                ..Default::default()
            }),
            0,
            true,
            "",
        )
        .expect("淘汰状态不同应报差异");
        assert!(detail.contains("淘汰"), "detail 缺少淘汰说明: {detail}");
    }

    #[test]
    fn expected_rejected_but_disk_not_is_reported() {
        let detail = describe_mismatch(
            &expected(PartialExpected {
                flag: Some("reject"),
                ..Default::default()
            }),
            0,
            false,
            "",
        )
        .expect("淘汰状态不同应报差异");
        assert!(detail.contains("淘汰"), "detail 缺少淘汰说明: {detail}");
    }

    #[test]
    fn rejected_on_both_sides_ignores_rating() {
        // 淘汰时磁盘星级恒为 0，不该因为 expected.rating 非零再报一条。
        assert!(no_mismatch(
            PartialExpected {
                rating: Some(5),
                flag: Some("reject"),
                ..Default::default()
            },
            (0, true, "")
        ));
    }

    #[test]
    fn label_difference_is_reported() {
        let detail = describe_mismatch(
            &expected(PartialExpected {
                label: Some("Red"),
                ..Default::default()
            }),
            0,
            false,
            "Blue",
        )
        .expect("色标不同应报差异");
        assert!(detail.contains("色标"), "detail 缺少色标说明: {detail}");
        assert!(detail.contains("Blue") && detail.contains("Red"), "detail 缺少色名: {detail}");
    }

    #[test]
    fn label_comparison_is_case_insensitive() {
        assert!(no_mismatch(
            PartialExpected {
                label: Some("Red"),
                ..Default::default()
            },
            (0, false, "red")
        ));
    }

    #[test]
    fn multiple_differences_are_joined() {
        let detail = describe_mismatch(
            &expected(PartialExpected {
                rating: Some(1),
                label: Some("Red"),
                ..Default::default()
            }),
            4,
            false,
            "Blue",
        )
        .expect("两项不同应报差异");
        assert!(detail.contains('；'), "多项差异应拼接: {detail}");
    }

    #[test]
    fn missing_sidecar_reads_as_empty_state() {
        // 从未写过侧边栏 = 0 星 / 未淘汰 / 无色标；预期一致时不该报冲突。
        let img = std::env::temp_dir().join(format!(
            "cullcheck_missing_{}.jpg",
            std::process::id()
        ));
        let _ = fs::remove_file(xmp::get_xmp_path(&img));

        let mismatches = collect_mismatches(vec![ExpectedCullState {
            path: img.to_string_lossy().to_string(),
            rating: 0,
            flag: "none".to_string(),
            label: String::new(),
        }]);
        assert!(mismatches.is_empty(), "无侧边栏不该报冲突: {mismatches:?}");
    }

    #[test]
    fn external_change_is_detected_through_a_real_sidecar() {
        let img = std::env::temp_dir().join(format!(
            "cullcheck_external_{}.jpg",
            std::process::id()
        ));
        let xmp_path = xmp::get_xmp_path(&img);
        let _ = fs::remove_file(&xmp_path);

        // 模拟「别的程序」把这张照片改成 3 星 + 蓝标。
        xmp::write_xmp(&img, 3, "none", Some("Blue")).expect("预置侧边栏应成功");

        // 我们以为它还是 2 星 + 红标。
        let mismatches = collect_mismatches(vec![ExpectedCullState {
            path: img.to_string_lossy().to_string(),
            rating: 2,
            flag: "none".to_string(),
            label: "Red".to_string(),
        }]);

        assert_eq!(mismatches.len(), 1, "应报一条冲突: {mismatches:?}");
        assert!(mismatches[0].detail.contains("星级"));
        assert!(mismatches[0].detail.contains("色标"));

        let _ = fs::remove_file(&xmp_path);
    }
}
