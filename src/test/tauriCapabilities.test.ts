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

describe('Tauri capabilities —— 窗口关闭链路', () => {
  it('default capability 显式授予 core:window:allow-destroy', () => {
    // core:default 不含 allow-destroy；这是窗口能被真正关闭的唯一授权来源。
    expect(caps.permissions).toContain('core:window:allow-destroy');
  });
});
