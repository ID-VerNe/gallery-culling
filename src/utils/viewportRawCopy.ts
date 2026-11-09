/**
 * RAW-only 占位 copy 的单一真值（issue #121）。
 *
 * 三视口历史各写一份：Preview 双分支（引擎可用=解码失败 / 不可用=需启用），
 * Split / BeforeAfter 单分支（只有「需启用」且各带「在此实时 / 在此对照预览」
 * 的文案差异）。收敛后以 Preview 双分支逐字为准，三处共用本函数。
 *
 * 渲染层（`ViewportEmptyStateView`）与解码口径（`viewportImage.ts:48`）保持
 * 不动，本文件只管这句文案。
 */
export interface RawOnlyEmptyState {
  title: string;
  description: string;
}

export function rawOnlyEmptyState({ engineAvailable }: { engineAvailable: boolean }): RawOnlyEmptyState {
  if (engineAvailable) {
    return {
      title: 'RAW 预览暂不可用',
      description: 'LUMEN RAW 引擎未能解码该照片，请稍后重试或改用其它视图。',
    };
  }
  return {
    title: '该 RAW 需启用 LUMEN RAW 引擎',
    description: '当前为 RAW-only 照片，启用 LUMEN RAW 引擎后即可实时预览；JPG 照片不受影响。',
  };
}
