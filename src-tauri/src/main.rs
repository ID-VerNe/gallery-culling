// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebView2 GPU 子进程崩溃 workaround（2026-10-15，e2e run6h 真窗口验证）。
    // 在部分 GPU 环境（双显卡 + 虚拟显示器驱动 + WebView2 155）下，GPU 子进程
    // 会在 STATIC_INIT 阶段连续崩溃（exit_code=7 ×9），Chromium 判定 GPU 不可
    // 用后浏览器进程自杀（"GPU process isn't usable. Goodbye."），表现为启动
    // 白屏 + "msedgewebview2 has stopped working"。
    // --in-process-gpu 让 GPU 走进程内实现，完全绕过该崩溃链：run6h 实测 0 次
    // 崩溃、e2e 场景全绿（对照 run6b-6g 全部 9 连崩）。
    // 已排除：应用代码改动、profile 损坏、GPU 缓存损坏、--disable-gpu、
    // --disable-features=SkiaGraphite（均无效）。
    // 若未来显卡驱动 / WebView2 更新修复根因，可删除本段恢复默认渲染路径；
    // 尊重用户已有设置（环境变量已存在时不覆盖）。
    #[cfg(windows)]
    if std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_none() {
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--in-process-gpu");
    }
    gallery_culling_lib::run();
}
