//! Step 1 集成契约测试：以**真实子进程**（Windows 批处理夹具）驱动
//! `exec_and_classify`，覆盖 spawn → 退出码分类 → stdout 解析的完整链路。
//!
//! 夹具不是被测逻辑的 mock；被测代码是真实的进程执行路径。
//! 契约依据：`.plan/specs/step1-lumen-bridge-core-spec.md` §4。

use std::path::PathBuf;
use std::process::Command;

use gallery_culling_lib::lumen::{exec_and_classify, LumenError};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
}

fn cmd_via_fixture(name: &str) -> Command {
    // 不手动加引号：Rust 的 argv 转义会自动为带空格路径加引号，
    // 手动引号会与转义叠加成双层引号，cmd /C 反而找不到命令。
    let mut cmd = Command::new("cmd");
    cmd.args(["/C", &fixture(name).display().to_string()]);
    cmd
}

#[test]
fn exec_and_classify_ok_parses_json() {
    let result = exec_and_classify(&mut cmd_via_fixture("lumen_fixture_ok.cmd"));
    let value = result.expect("exit 0 + 合法 JSON 应 Ok");
    assert_eq!(value["ok"], serde_json::json!(true));
    assert_eq!(value["result"]["width"], serde_json::json!(1600));
}

#[test]
fn exec_and_classify_bad_json_is_protocol_error() {
    let err = exec_and_classify(&mut cmd_via_fixture("lumen_fixture_badjson.cmd"))
        .expect_err("exit 0 + 非 JSON 应 Err");
    assert!(
        matches!(err, LumenError::Protocol(_)),
        "应分类为 Protocol，实际: {:?}",
        err
    );
}

#[test]
fn exec_and_classify_exit1_strips_lumen_prefix() {
    let err = exec_and_classify(&mut cmd_via_fixture("lumen_fixture_fail.cmd"))
        .expect_err("exit 1 应 Err");
    match err {
        LumenError::Command(m) => {
            assert!(
                m.starts_with("file not found:"),
                "应剥离 `lumen-cli: ` 前缀，实际: {}",
                m
            );
        }
        other => panic!("应分类为 Command，实际: {:?}", other),
    }
}
