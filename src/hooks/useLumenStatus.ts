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
 * E7：握手前的过渡态。开关已存为"启用"、但 1500ms 探测尚未返回时，不能沿用
 * `LUMEN_UNAVAILABLE.detail`（"未启用…"），否则状态行与勾选框自相矛盾。
 * 这里给出"正在探测引擎…"，让 UI 在探测窗口内呈现中性的进行中状态。
 */
const probingStatus = (): LumenStatus => ({
  ...LUMEN_UNAVAILABLE,
  enabled: true,
  detail: '正在探测引擎…',
});

/**
 * LUMEN RAW 引擎握手状态。
 *
 * - 延迟 1500ms 再握手：不阻塞首屏，且给 sidecar 冷启动留出时间；
 * - 调用方传 `enabled=false` 时**完全不发请求**（settings.lumenEnabled 关闭时零 invoke）；
 * - 请求失败不抛错，静默降级为不可用（UI 走旧的内嵌 JPEG 路径）。
 *
 * N-12：早期 effect 只依赖 `enabled`，导致**改路径 / 保存设置后引擎状态永不刷新**，
 * 弹窗里显示的是启动时的陈旧快照。现在依赖覆盖 `enabled` 与 `cliPath`（设置保存后
 * `settings` 换了新对象，路径变化即重新探测），并可用 `refreshToken` 主动触发重探
 * （宿主在「保存设置」后自增即可，见 App 接入片段）。
 */
export const useLumenStatus = (
  enabled: boolean,
  cliPath: string = '',
  refreshToken: number = 0,
): LumenStatus => {
  // E7：初始态即反映"是否正在探测"——enabled 为真时先给过渡态，避免前 1.5s
  // 显示"未启用…"与勾选框矛盾。
  const [status, setStatus] = useState<LumenStatus>(() =>
    enabled ? probingStatus() : LUMEN_UNAVAILABLE,
  );

  useEffect(() => {
    if (!enabled) {
      setStatus(LUMEN_UNAVAILABLE);
      return;
    }
    // 重探（改路径 / refreshToken）时先回到过渡态，避免短暂显示上一次的旧状态。
    setStatus(probingStatus());
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
    // cliPath 入依赖：路径变化（含保存设置后的新对象）必须重探；
    // refreshToken 入依赖：给宿主一个「无条件重探」的显式开关（N-12）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, cliPath, refreshToken]);

  return status;
};