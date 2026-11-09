import React from 'react';

/**
 * 「正在渲染 RAW…」横幅的单一真值（issue #121）。
 *
 * 历史三处：Preview 大档（top-4 px-3.5 py-1.5 text-xs） vs Split/BeforeAfter
 * 小档（top-3 px-3 py-1 text-[11px]），class 漂移。收敛后以 Preview 大档
 * 逐字为准，三处共用本组件。可见性条件（`loading` / `!lumenActive`）留
 * 调用侧，不进本组件——Preview 保留 `!lumenActive` 决策只是调用点不同，
 * markup 仍同一份。
 */
export const RawRenderingBanner: React.FC = () => (
  <div
    role="status"
    className="absolute top-4 left-1/2 -translate-x-1/2 bg-background-base/90 backdrop-blur-md px-3.5 py-1.5 rounded-md text-xs font-semibold text-white/80 border border-border-default pointer-events-none"
  >
    正在渲染 RAW…
  </div>
);
