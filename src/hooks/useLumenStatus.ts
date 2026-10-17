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
 * 探测窗口内的提示文案。
 *
 * 提成常量而不是字面量，因为它同时充当「是否仍在探测」的判据 ——
 * 两处各写一遍的话，改文案就会让 `toLumenGateStatus` 静默失效。
 */
export const LUMEN_PROBING_DETAIL = '正在探测引擎…';

/**
 * E7：握手前的过渡态。开关已存为"启用"、但 1500ms 探测尚未返回时，不能沿用
 * `LUMEN_UNAVAILABLE.detail`（"未启用…"），否则状态行与勾选框自相矛盾。
 * 这里给出"正在探测引擎…"，让 UI 在探测窗口内呈现中性的进行中状态。
 */
const probingStatus = (): LumenStatus => ({
  ...LUMEN_UNAVAILABLE,
  enabled: true,
  detail: LUMEN_PROBING_DETAIL,
});

/**
 * 把握手状态折叠成导出弹窗需要的三态。
 *
 * 为什么需要这层：`LumenStatus` 是给设置页用的详细对象（版本、路径、AI flavor），
 * 而导出弹窗只关心「能不能渲」。让弹窗自己从五个字段里推断状态，会把这份
 * 判断复制到每个消费方 —— 这里折叠一次，弹窗只读一个字符串。
 */
export function toLumenGateStatus(
  status: LumenStatus,
): 'probing' | 'unavailable' | 'available' {
  if (status.available) return 'available';
  // 开关已启用但握手未返回 → 仍在探测（唯一可靠判据，见 LUMEN_PROBING_DETAIL 注释）
  if (status.enabled && status.detail === LUMEN_PROBING_DETAIL) return 'probing';
  return 'unavailable';
}

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
        .catch((err) => {
          if (!cancelled) {
            // 原样透传失败原因，而不是硬编码一句「请检查路径」。用户真正需要知道
            // 的是「路径不存在 / 权限不足 / 端口被占 / 进程找不到」中的哪一个 ——
            // 丢弃 err 等于让用户自己去猜。这也是项目自身 lumenApi.ts 约定的
            // 「原样透传不改写」。
            const reason = err instanceof Error ? err.message : String(err);
            setStatus({
              ...LUMEN_UNAVAILABLE,
              enabled: true,
              detail: `无法连接 LUMEN RAW：${reason}（请检查设置中的路径）`,
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