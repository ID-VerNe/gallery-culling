import { useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { LumenStatus } from '../types';
import { PhotoGroupInfo } from '../types';

/** 同一张图最多尝试渲染几次（失败后不再请求，避免翻页时反复等待）。 */
const MAX_ATTEMPTS = 2;

export interface UseLumenPreviewResult {
  /** LUMEN RAW 渲染出的预览 asset URL；null = 走旧路径（内嵌 JPEG / JPG） */
  url: string | null;
  loading: boolean;
  /** 该组是否尝试过并失败（用于静默降级，不弹 toast） */
  failed: boolean;
}

/**
 * RAW 真实解码预览（LUMEN RAW sidecar）。
 *
 * 降级契约（全部静默，零报错弹窗）：
 *  - 有 JPG → 直接用 JPG，不请求；
 *  - 引擎不可用 / 未启用 → null；
 *  - 渲染失败或返回 previewPath=null → null（并计入 attempts，避免重试风暴）；
 *  - 切换照片立即作废旧结果（防串图）。
 */
export const useLumenPreview = (
  group: PhotoGroupInfo | undefined,
  status: LumenStatus,
  width = 1600,
): UseLumenPreviewResult => {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const attemptsRef = useRef(new Map<string, number>());

  const groupId = group?.id;
  const hasJpg = Boolean(group?.jpg?.path);
  const rawPath = group?.raw?.path;
  const available = status.available;

  useEffect(() => {
    // 切图：立即作废旧结果
    setUrl(null);
    setFailed(false);
    setLoading(false);

    if (!groupId) return;
    if (hasJpg) return; // JPG 优先（速度优先，选片心智不变）
    if (!available || !rawPath) return; // 引擎不可用 → 静默降级

    const attempts = attemptsRef.current;
    if ((attempts.get(groupId) ?? 0) >= MAX_ATTEMPTS) {
      setFailed(true);
      return;
    }

    let cancelled = false;
    setLoading(true);
    api
      .getLumenPreview(rawPath, { width, original: false })
      .then((res) => {
        if (cancelled) return;
        if (res.previewPath) {
          setUrl(api.toAssetUrl(res.previewPath));
        } else {
          attempts.set(groupId, (attempts.get(groupId) ?? 0) + 1);
          setFailed(true);
        }
      })
      .catch(() => {
        if (cancelled) return;
        attempts.set(groupId, (attempts.get(groupId) ?? 0) + 1);
        setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [groupId, hasJpg, available, rawPath, width]);

  // UX-31：attemptsRef 只增不删 —— MAX_ATTEMPTS 只是阻止同一张反复重试，
  // 但 Map 每浏览一张新照片就多一个条目。万张规模的浏览会话会让它无界增长，
  // 而键（group id）在会话内早已失去意义。按分组切换时驱逐旧条目。
  useEffect(() => {
    const attempts = attemptsRef.current;
    return () => {
      // 卸载/切换后清理本分组累积的计数，避免长会话无限堆积。
      // 只清当前 groupId 的键，不碰其它分组正在进行的重试状态。
      if (groupId) attempts.delete(groupId);
    };
  }, [groupId]);

  return { url, loading, failed };
};