import { useEffect, useState } from 'react';
import type { LumenStatus, PhotoGroupInfo } from '../types';
import { useLumenPreview } from './useLumenPreview';
import { resolveViewportImage } from '../utils/viewportImage';

/** useViewportImage 的返回面（在解析结果上补加载态与 latch 入口）。 */
export interface ViewportImage {
  /** 最终 `<img src>`；null = 该渲染占位（RAW-only 且 LUMEN 没顶上）。 */
  src: string | null;
  /** 无 JPG 的 RAW 分组（C2：引擎没顶上时也不回落 .NEF 资产 URL）。 */
  rawOnly: boolean;
  /** LUMEN 预览真实命中（据此不叠加 CSS 调色滤镜，否则 develop 两次）。 */
  lumenActive: boolean;
  /** LUMEN 渲染是否进行中（「正在渲染 RAW…」横幅用）。 */
  loading: boolean;
  /**
   * `<img onError>` 入口：陈旧/损坏的缓存预览加载失败时 latch。
   * 内部自带「url 有效且未 latch」守卫，调用方直接 `onError={image.markBroken}`。
   * latch 期间 src 回落为 null（C2：不回落 .NEF），由占位接手。
   */
  markBroken: () => void;
}

/**
 * 视口图片源 = LUMEN RAW 预览 + 失败 latch + 解析（三视口共用）。
 *
 * 抽取前三个视口各自重复同一套机关：`useLumenPreview` 调用、换图复位
 * latch 的 effect、`hasJpg/hasRaw/rawOnly/lumenActive/legacySrc/src` 六行
 * 解算、onError 里的三重守卫。收拢后：
 *  - 解析口径单一真值在 `resolveViewportImage`（纯函数，有单测）；
 *  - latch 语义（换图复位 + markBroken 守卫）只写一遍；
 *  - 调用方面从「三个平行值 + 两个 state」变成一个对象。
 *
 * SplitCompareViewport 需要两个实例（左右各一），在组件体调两次本 hook
 * 再传进 renderPane —— 守 hook 规则（不在循环/条件里调 hook）。
 */
export function useViewportImage(
  group: PhotoGroupInfo | undefined,
  lumenStatus: LumenStatus,
  width = 1600,
): ViewportImage {
  const lumen = useLumenPreview(group, lumenStatus, width);
  const [broken, setBroken] = useState(false);

  // 换图复位 latch：新照片的旧失败记录不作数（缩放/平移的复位归各自的 hook）。
  useEffect(() => {
    setBroken(false);
  }, [group?.id]);

  const resolved = resolveViewportImage(group, lumen, broken);
  return {
    ...resolved,
    loading: lumen.loading,
    markBroken: () => {
      // 守卫与抽取前逐字一致：只有 LUMEN 预览真正渲染成功过、且尚未 latch
      // 时才掐断 —— JPG 加载失败不该触发任何 LUMEN 相关行为。
      if (lumen.url && !broken) setBroken(true);
    },
  };
}
