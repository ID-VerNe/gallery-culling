/**
 * 订阅「LUMEN 引擎启动预热失败」事件，用常驻错误提示让用户看得见。
 *
 * 背景（issue #68）：sidecar 随包分发后会在应用启动时后台预热。预热失败若只在
 * 设置页状态行里体现，不打开设置就等于静默失败——所以后端同时发事件，这里
 * 转成 toast。事件名与 Rust 侧 `lumen::STARTUP_ERROR_EVENT` 必须一致。
 */
import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useToast } from '../components/Toast';

/** 与 `src-tauri/src/lumen.rs` 的 `STARTUP_ERROR_EVENT` 同名。 */
export const LUMEN_STARTUP_ERROR_EVENT = 'lumen-startup-error';

export const useLumenStartupNotice = (): void => {
  const toast = useToast();

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<string>(LUMEN_STARTUP_ERROR_EVENT, (event) => {
      if (disposed) return;
      toast.error(`LUMEN RAW 引擎启动失败：${event.payload}`);
    }).then((fn) => {
      // 组件卸载可能早于 listen 的 Promise 落地：此时立刻退订，避免泄漏。
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [toast]);
};
