import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';
import type { LumenCapabilities, PhotoGroupInfo } from '../types';
import { useToast } from '../components/Toast';
import { groupPath } from '../utils/groupPath';

/** 工程里现有的 AI 蒙版（`listLumenMasks` 的返回元素）。 */
export interface LumenMaskInfo {
  index?: number;
  name?: string;
  kind?: string;
}

export interface UseLumenOrchestrationArgs {
  /** 引擎握手是否成功（`useLumenStatus().available`）。失败时零请求、caps 归零。 */
  available: boolean;
  /** 设置里的宫格 LUMEN 缩略图开关；未握手时不生效。 */
  gridThumbnails: boolean;
  /** 同步评级目录兜底之一：设置里的默认 RAW 目录。 */
  defaultRawFolder?: string;
  /** 同步评级目录兜底之一：当前分组路径（取所在目录）。 */
  currentGroup?: PhotoGroupInfo;
  /** 同步产生了评级变化 → 重扫当前目录（星级排序与选中框跟着变）。 */
  onRescan: () => void | Promise<void>;
  /** 重扫条件：原 App.tsx 的口径是「jpgFolder 非空才重扫」。 */
  jpgFolder: string;
}

export interface UseLumenOrchestrationResult {
  /** sidecar 真实能力（命令表/预设/AI 蒙版）；仅在握手成功时探测一次。 */
  caps: LumenCapabilities | null;
  /** 工程里现有的 AI 蒙版（useToneEditing 写入，TonalAdjuster 读取）。 */
  masks: LumenMaskInfo[];
  /** 透传给 useToneEditing 的 `onMasksLoaded`。 */
  onMasksLoaded: (masks: LumenMaskInfo[]) => void;
  /** 宫格是否切到 LUMEN 渲染（设置开启且握手成功）。 */
  gridThumbs: boolean;
  /** 设置弹窗的「从 LUMEN RAW 同步评级」，返回同步张数。 */
  syncRatings: (folder: string) => Promise<number>;
}

/**
 * LUMEN RAW 引擎的前端编排：能力探测、AI 蒙版状态、宫格缩略图开关、评级同步。
 *
 * 四件事在原 App.tsx 里散落成「一个 state + 一个 effect + 一个派生值 + 一个
 * 40 行回调」，但同属 LUMEN 域且互相引用（caps 决定预设/蒙版入口，masks 由
 * 调色 hook 写入、调色面板读取）。收拢后的不变量：
 *  - 握手失败 → caps 归零、零请求（设置里重探令牌自增会再次触发探测）；
 *  - 探测只发一次（effect 依赖只有 `available`）；
 *  - 同步评级后有变化才重扫，且重扫走调用方的 handleScan（依赖它的目录状态）。
 */
export function useLumenOrchestration({
  available,
  gridThumbnails,
  defaultRawFolder,
  currentGroup,
  onRescan,
  jpgFolder,
}: UseLumenOrchestrationArgs): UseLumenOrchestrationResult {
  const toast = useToast();
  const [caps, setCaps] = useState<LumenCapabilities | null>(null);
  const [masks, setMasks] = useState<LumenMaskInfo[]>([]);

  // sidecar 真实能力（命令表/预设/AI）。只在握手成功时探测一次。
  useEffect(() => {
    if (!available) {
      setCaps(null);
      return;
    }
    let active = true;
    api
      .getLumenCapabilities()
      .then((c) => active && setCaps(c))
      .catch((e) => console.warn('LUMEN 能力探测失败:', e));
    return () => {
      active = false;
    };
  }, [available]);

  const syncRatings = useCallback(
    async (folder: string): Promise<number> => {
      const target = folder || defaultRawFolder || groupPath(currentGroup) || '';
      if (!target) {
        toast.error('没有可同步的路径，请先设置默认 RAW 目录。');
        return 0;
      }
      // 取所在目录（同时兼容 / 与 \ 分隔符）
      const lastSlash = Math.max(
        target.lastIndexOf('/'),
        target.lastIndexOf(String.fromCharCode(92)),
      );
      const folderPath = lastSlash > 0 ? target.slice(0, lastSlash) : '';
      if (!folderPath) {
        toast.error('无法确定所在目录，请先设置默认 RAW 目录。');
        return 0;
      }
      const result = await api.syncLumenRatings(folderPath);
      if (result.updated.length > 0) {
        toast.success(`已从 LUMEN RAW 同步 ${result.updated.length} 张的评级。`);
        // 评级变了 → 星级排序与边框都要跟着变，重新扫描当前目录
        if (jpgFolder) await onRescan();
      }
      if (result.conflicts.length > 0) {
        const first = result.conflicts[0];
        toast.error(
          `${result.conflicts.length} 张照片在两边都被改过，已保持本机值不覆盖。\n` +
            `例如 ${first.path}：本机 ${first.hostRating}★/${first.hostFlag}，` +
            `LUMEN RAW ${first.lumenRating}★/${first.lumenFlag}。`,
        );
      }
      return result.updated.length;
    },
    // `onRescan`（handleScan）依赖 jpgFolder/rawFolder/sortOrder
    [defaultRawFolder, currentGroup, toast, jpgFolder, onRescan],
  );

  return {
    caps,
    masks,
    onMasksLoaded: setMasks,
    // 宫格引擎开关：仅在设置开启且引擎握手成功时才切到 lumen 渲染
    gridThumbs: gridThumbnails && available,
    syncRatings,
  };
}
