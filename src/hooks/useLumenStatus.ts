import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { LumenStatus } from '../types';

/** 引擎不可用时的默认状态（不请求、不报错）。 */
export const LUMEN_UNAVAILABLE: LumenStatus = {
  available: false,
  enabled: false,
  pinnedVersion: '',
  foundVersion: null,
  detail: '未启用 LUMEN RAW 引擎',
};

/**
 * LUMEN RAW 引擎握手状态。
 *
 * - 延迟 1500ms 再握手：不阻塞首屏，且给 sidecar 冷启动留出时间；
 * - 调用方传 `enabled=false` 时**完全不发请求**（settings.lumenEnabled 关闭时零 invoke）；
 * - 请求失败不抛错，静默降级为不可用（UI 走旧的内嵌 JPEG 路径）。
 */
export const useLumenStatus = (enabled: boolean): LumenStatus => {
  const [status, setStatus] = useState<LumenStatus>(LUMEN_UNAVAILABLE);

  useEffect(() => {
    if (!enabled) {
      setStatus(LUMEN_UNAVAILABLE);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .getLumenStatus()
        .then((s) => {
          if (!cancelled) setStatus(s);
        })
        .catch(() => {
          if (!cancelled) {
            setStatus({
              ...LUMEN_UNAVAILABLE,
              enabled: true,
              detail: '无法连接 LUMEN RAW（请检查设置中的路径）',
            });
          }
        });
    }, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled]);

  return status;
};