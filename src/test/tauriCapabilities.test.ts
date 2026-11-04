/**
 * Tauri capability 静态护栏 —— 窗口关闭链路。
 *
 * 背景（2026-10-17）：用户报「右上角 X 不能正确退出」。
 *
 * 链路：`useSessionDebounce` 在 `onCloseRequested` 里 `event.preventDefault()`
 * → flush 会话 → `win.destroy()`。但 `capabilities/default.json` 当时只授了
 * `core:default`，而 `core:window:default` 的 28 项里**不含** `allow-destroy`
 * （见 `src-tauri/gen/schemas/acl-manifests.json`）→ destroy 被 ACL 拒绝 →
 * 窗口被 preventDefault 拦住、又关不掉，X 完全失效。
 *
 * 这类回归在 jsdom 里抓不到（mock 的 destroy 永远成功），所以用配置断言兜住：
 * 谁删掉这条权限，谁就在这里红灯。
 */
import caps from '../../src-tauri/capabilities/default.json';
import desktopCaps from '../../src-tauri/capabilities/desktop.json';
import tauriConf from '../../src-tauri/tauri.conf.json';

describe('Tauri capabilities —— 窗口关闭链路', () => {
  it('default capability 显式授予 core:window:allow-destroy', () => {
    // core:default 不含 allow-destroy；这是窗口能被真正关闭的唯一授权来源。
    expect(caps.permissions).toContain('core:window:allow-destroy');
  });
});

describe('Tauri capabilities —— 更新重启链路（issue #43）', () => {
  /**
   * 背景：Windows 上 `downloadAndInstall` 装完即 `exit(0)`，真正的重启由 NSIS
   * 的 `/R` 负责。`relaunch()` 是手动兜底路径，仍需要 ACL —— 缺授权时
   * `plugin:process|restart` 会被拒，而 jsdom 的 mock 永远成功，只能靠配置断言。
   * 注意权限 id 是 `process:`，不是 `core:process:`。
   */
  it('default capability 显式授予 process:allow-restart', () => {
    expect(caps.permissions).toContain('process:allow-restart');
  });

  it('desktop capability 仍然只承载 updater 与平台声明（不重复授权）', () => {
    // 覆盖窗口的是 default 的 windows:["*"]；desktop 无需再写一遍。
    expect(desktopCaps.permissions).toContain('updater:default');
    expect(desktopCaps.permissions).not.toContain('process:allow-restart');
  });
});

describe('Tauri 配置 —— 更新安装模式（issue #43）', () => {
  /**
   * `basicUi` 不会给安装器传 `/R`（tauri-plugin-updater-2.11.0/src/config.rs:53-57），
   * 那会把「装完自动重启」变成静默失效。显式声明 `passive` 是给这条链路加锁。
   */
  it('plugins.updater.windows.installMode 显式为 passive', () => {
    const windows = (
      tauriConf.plugins.updater as { windows?: { installMode?: string } }
    ).windows;
    expect(windows?.installMode).toBe('passive');
  });
});
