/**
 * 订阅引擎包下载状态（issue #75）。
 *
 * 引擎不再随安装包分发：应用启动时后台会确保缓存就位，缺失则从独立 Release
 * 资产下载。这个 hook 只负责「把状态读出来 + 提供重试」，不阻塞任何界面。
 *
 * 事件名与 Rust 侧 `lumen::ENGINE_STATUS_EVENT` 必须一致。
 */
import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { api } from '../services/api';
import type { LumenEngineStatus } from '../types';

/** 与 `src-tauri/src/lumen/engine.rs` 的 `ENGINE_STATUS_EVENT` 同名。 */
export const LUMEN_ENGINE_STATUS_EVENT = 'lumen-engine-status';

export interface LumenEngineHandle {
  /** 当前状态；`null` 表示尚未拿到（首屏不渲染横幅）。 */
  status: LumenEngineStatus | null;
  /** 正在执行一次手动重试（按钮禁用态）。 */
  retrying: boolean;
  /** 重试下载：后台启动，进度继续走事件。 */
  retry: () => void;
}

export const useLumenEngine = (): LumenEngineHandle => {
  const [status, setStatus] = useState<LumenEngineStatus | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // 先主动读一次：应用启动早期的事件可能早于 listen 落地，避免漏掉。
    void api
      .getLumenEngineStatus()
      .then((snapshot) => {
        if (!disposed) setStatus((current) => current ?? snapshot);
      })
      .catch(() => {
        // 读状态失败不影响主界面；后续事件仍会更新。
      });
    void listen<LumenEngineStatus>(LUMEN_ENGINE_STATUS_EVENT, (event) => {
      if (!disposed) setStatus(event.payload);
    }).then((fn) => {
      // 组件卸载可能早于 listen 的 Promise 落地：立刻退订，避免泄漏。
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const retry = useCallback(() => {
    setRetrying(true);
    void api
      .ensureLumenEngine()
      .then((snapshot) => setStatus(snapshot))
      .catch((err) => {
        setStatus((current) => ({
          phase: 'failed',
          version: current?.version ?? '',
          detail: `重试失败：${err instanceof Error ? err.message : String(err)}。下一步：检查网络后重试，或在设置中手动指定 lumen-cli.exe。`,
          downloadedBytes: 0,
          totalBytes: 0,
        }));
      })
      .finally(() => setRetrying(false));
  }, []);

  return { status, retrying, retry };
};
