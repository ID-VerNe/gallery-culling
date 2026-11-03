import { useEffect, useRef, useState } from 'react';

/**
 * 右侧栏交叉淡入的最小 presence 机制（issue #18 · PB-13）。
 *
 * 背景：原先 `tonalPanelVisible` 的三元直接换树，390px 整体硬切；底栏
 * (`viewportBarStyles.ts:83`) 同一层级已经做了 200ms 三属性联动，两套标准。
 * 这里给换面板加 200ms 交叉淡入——**不做位移**（390px 位移会过冲）。
 *
 * 为什么不抽成全局 presence：
 * PB-12（issue #18 另列）要做模态 presence，与本机制的需求不同（模态有 scrim、
 * 单次开关、需要 Esc 同步；面板互换是双向、无 scrim）。先各自最小实现，避免
 * 与未来 PB-12 的实现冲突。
 *
 * 契约：
 * - `active`：当前应展示哪一面（'grid' | 'tonal'）。
 * - 退场面板在 `EXIT_MS` 后才从 DOM 卸载，期间标 `data-exiting="true"`，
 *   让 CSS 把它淡出（`opacity-0`）。进场面板挂载即 `opacity-100`。
 * - 切换瞬间两面都在 DOM 里（绝对定位叠放），交叉淡入。
 * - 不在测试里改时长：测试用 `vi.useFakeTimers` + `advanceTimersByTime` 推进，
 *   时长仍是 200ms（`EXIT_MS`），保持与真实一致。
 */
export type SidebarPanel = 'grid' | 'tonal';

/** 退场面板延迟卸载的时间（ms）。与 CSS `duration-200` 配对——200ms 是本仓
 *  `viewportBarStyles.ts:83` 底栏的既定标准，右侧栏与之同层同速。 */
export const EXIT_MS = 200;

interface MountedPanel {
  readonly key: SidebarPanel;
  readonly exiting: boolean;
}

export interface SidebarCrossFade {
  /** 当前在场的面板（含正在退场的）。切完后只剩一个。 */
  readonly mounted: readonly MountedPanel[];
  /** 当前应展示的面板（= 入参 active）。 */
  readonly active: SidebarPanel;
}

/**
 * @param active 当前应展示哪一面。
 * @returns 在场面板列表（含退场标记）。调用方按列表渲染，给 `exiting` 的面板
 *          标 `data-exiting` 与 `opacity-0`，给当前的标 `opacity-100`。
 */
export function useSidebarCrossFade(active: SidebarPanel): SidebarCrossFade {
  const [mounted, setMounted] = useState<readonly MountedPanel[]>([
    { key: active, exiting: false },
  ]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(active);

  useEffect(() => {
    if (active === activeRef.current) return;
    const prev = activeRef.current;
    activeRef.current = active;

    // 立刻：新面板挂载（opacity-0→100 由 CSS transition），旧面板标退场。
    setMounted([
      { key: prev, exiting: true },
      { key: active, exiting: false },
    ]);

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      // EXIT_MS 后卸载退场面板，只剩当前。
      setMounted([{ key: activeRef.current, exiting: false }]);
      timerRef.current = null;
    }, EXIT_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [active]);

  return { mounted, active };
}
