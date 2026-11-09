import { useCallback, useRef, useState } from 'react';
import { api } from '../services/api';
import { useToast } from '../components/Toast';
import { computeAutoTone } from '../utils/autoTone';
import type { PhotoGroupInfo, ToneAdjustments, ViewMode } from '../types';

/**
 * 自动调色采样管线（issue #113：自 `useToneEditing` 按管线拆出）。
 *
 * 只负责「采到什么值」：当前渲染图 → JPG 副本 → LUMEN 预览 三段回退。
 * 采到的值经门面注入的 `onUserToneChange` 写内存并（开启时）调度自动保存，
 * 本 hook 不拥有写盘队列。
 */
export function useAutoTone(opts: {
  currentGroup: PhotoGroupInfo | undefined;
  viewMode: ViewMode;
  lumenAvailable: boolean;
  onUserToneChange: (tone: ToneAdjustments) => void;
}) {
  const { currentGroup, viewMode, lumenAvailable, onUserToneChange } = opts;
  const toast = useToast();

  /** UX-12：auto-tone 计算中。RAW-only 要等 LUMEN 预览渲染，采样也是异步的，
      全程数秒无任何反馈，按钮看起来像没生效。 */
  const [isAutoToning, setIsAutoToning] = useState(false);

  // The <img> currently rendered in the single-view viewport, so auto-tone can
  // sample the histogram without a fragile DOM query (F-15).
  const previewImageRef = useRef<HTMLImageElement | null>(null);
  const setPreviewImage = useCallback((el: HTMLImageElement | null) => {
    previewImageRef.current = el;
  }, []);

  const handleAutoTone = useCallback(async () => {
    if (!currentGroup || isAutoToning) return;
    /** 采样并写入滑杆；失败返回 false（调用方决定回退，绝不静默）。 */
    const finish = (img: HTMLImageElement): boolean => {
      const result = computeAutoTone(img);
      if (!result) return false;
      // 自动调色同样是用户主动改动：自动保存开启时要落盘。
      onUserToneChange(result);
      setIsAutoToning(false);
      return true;
    };

    const loadAndFinish = (src: string) => {
      const tempImg = new Image();
      tempImg.crossOrigin = 'anonymous';
      tempImg.onload = () => {
        if (finish(tempImg)) return;
        // 副本也采不动（画布采样被拦截）→ 如实报错，不留「点了没反应」
        setIsAutoToning(false);
        toast.error('无法读取该照片的像素数据（画布采样被拦截），自动调色已取消。');
      };
      tempImg.onerror = () => {
        setIsAutoToning(false);
        toast.error('无法读取该照片的像素数据，自动调色已取消。');
      };
      tempImg.src = src;
    };

    // The viewport hands us the element it actually rendered, so this works
    // even when two photos share a basename (F-15). 仅单图模式有注入，
    // 对比/前后模式 `previewImageRef` 可能残留旧图，必须忽略。
    const rendered = previewImageRef.current;
    if (
      viewMode === 'single' &&
      rendered &&
      rendered.complete &&
      rendered.naturalWidth > 0
    ) {
      setIsAutoToning(true);
      if (finish(rendered)) return;
      // 渲染图采样失败（历史遗留的 canvas 污染，问题二）→ 用带 CORS 的
      // 副本重采样兜底；副本也失败会在 onload/onerror 里如实报错。
      loadAndFinish(rendered.src);
      return;
    }

    // 有 JPG 就直接采样 JPG，零成本且必成功。
    if (currentGroup.jpg?.path) {
      setIsAutoToning(true);
      loadAndFinish(api.toAssetUrl(currentGroup.jpg.path));
      return;
    }

    // C10：RAW-only 时不能再回落到 `raw.path`（那是 .NEF，浏览器解不了，
    // 必然 onerror）。改为采样 LUMEN RAW 渲染出的预览图；引擎不可用时给出
    // 明确说明，而不是丢一句"无法读取像素数据"。
    const rawPath = currentGroup.raw?.path;
    if (rawPath && lumenAvailable) {
      setIsAutoToning(true);
      try {
        const prev = await api.getLumenPreview(rawPath, { width: 1024 });
        if (prev.previewPath) {
          loadAndFinish(api.toAssetUrl(prev.previewPath));
          return;
        }
      } catch (e) {
        console.warn('自动调色：LUMEN 预览取样失败', e);
      }
    }

    setIsAutoToning(false);
    toast.error(
      '无法读取该照片的像素数据：RAW 自动调色需要启用 LUMEN RAW 引擎（或同时选择 JPG 文件夹）。',
    );
  }, [currentGroup, onUserToneChange, isAutoToning, toast, viewMode, lumenAvailable]);

  return { isAutoToning, setPreviewImage, handleAutoTone };
}
