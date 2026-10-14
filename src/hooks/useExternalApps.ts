import { useCallback, useState } from 'react';
import type React from 'react';
import { api } from '../services/api';
import type { PhotoFileInfo, PhotoGroupInfo, ViewMode } from '../types';
import { useToast } from '../components/Toast';
import { groupPath } from '../utils/groupPath';

export interface UseExternalAppsArgs {
  /** 当前分组（外部打开与往返的目标）。 */
  currentGroup?: PhotoGroupInfo;
  /** 设置里的 Photoshop 路径；缺失时直接用默认程序打开。 */
  photoshopPath?: string;
  /** 把往返成品乐观落回集合（App 的 patchGroup）。 */
  onGroupPatched: (id: string, patch: Partial<PhotoGroupInfo>) => void;
}

export interface UseExternalAppsResult {
  /** 视图模式（single / split / before_after）。 */
  viewMode: ViewMode;
  setViewMode: React.Dispatch<React.SetStateAction<ViewMode>>;
  toggleCompare: () => void;
  toggleBeforeAfter: () => void;
  /** Photoshop / 默认程序打开当前照片（快捷键 O）。PS 失败自动回落默认程序。 */
  openExternal: () => Promise<void>;
  /** Luminar AI 往返：成功后把 edited 落回集合并切到前后对照视图。 */
  openLuminar: () => Promise<void>;
  /** 往返进行中（视图按钮的禁用/旋转态）。 */
  isLuminarRunning: boolean;
}

/**
 * 外部应用交互与视图模式。
 *
 * 视图模式与外部跳转合成一个 hook 的理由：**Luminar 往返的终点就是切视图**
 * （成功后自动进前后对照），两者是同一个交互单元；拆开就要为「往返完成」
 * 建一个回调桥，反而多一层间接。
 *
 * 口径（与抽取前的 App.tsx 逐一核对）：
 *  - 外部打开：PS 失败 → 静默回落默认程序 → 再失败才 toast（带设置指引）；
 *  - 往返：全程 try/catch/finally，`isLuminarRunning` 保证不重入；
 *    edited 信息（路径/名/扩展/大小/时间）按原样构造后走 onGroupPatched；
 *  - 视图切换：toggle 类在 single 与目标模式间互切，不做三态轮转。
 */
export function useExternalApps({
  currentGroup,
  photoshopPath,
  onGroupPatched,
}: UseExternalAppsArgs): UseExternalAppsResult {
  const toast = useToast();
  const [viewMode, setViewMode] = useState<ViewMode>('single');
  const [isLuminarRunning, setIsLuminarRunning] = useState(false);

  const openExternal = useCallback(async () => {
    if (!currentGroup) return;
    const targetPath = groupPath(currentGroup);
    if (!targetPath) return;

    try {
      await api.openInPhotoshop(targetPath, photoshopPath);
    } catch (e) {
      console.warn('Photoshop failed, falling back to default:', e);
      try {
        await api.openInDefaultApp(targetPath);
      } catch (fallbackErr) {
        toast.error(
          `无法打开该照片：${String(fallbackErr)}\n请在「设置」中确认 Photoshop 路径，或安装一个能打开此格式的程序。`,
        );
      }
    }
  }, [currentGroup, photoshopPath, toast]);

  const openLuminar = useCallback(async () => {
    if (!currentGroup) return;
    const targetPath = groupPath(currentGroup);
    if (!targetPath) return;

    setIsLuminarRunning(true);
    try {
      const editedPath = await api.openInLuminarRoundtrip(targetPath);
      const ext = editedPath.split('.').pop() || 'tif';
      const editedInfo: PhotoFileInfo = {
        path: editedPath,
        name: editedPath.split(/[/\\]/).pop() || 'edited.tif',
        extension: ext,
        size: 0,
        mtime: Date.now() / 1000,
      };

      onGroupPatched(currentGroup.id, { edited: editedInfo });

      // Automatically switch to Before/After comparison view to review result!
      setViewMode('before_after');
      toast.success('Luminar AI 精修完成，已切换到前后对照视图查看效果。');
    } catch (err) {
      console.error('Luminar roundtrip failed:', err);
      toast.error(
        `调用 Luminar AI 失败或未完成：${String(err)}\n请确认 Luminar AI 已安装，并已在「设置」中允许作为 Photoshop 插件运行。`,
      );
    } finally {
      setIsLuminarRunning(false);
    }
  }, [currentGroup, toast, onGroupPatched]);

  const toggleCompare = useCallback(() => {
    setViewMode((m) => (m === 'split' ? 'single' : 'split'));
  }, []);

  const toggleBeforeAfter = useCallback(() => {
    setViewMode((m) => (m === 'before_after' ? 'single' : 'before_after'));
  }, []);

  return {
    viewMode,
    setViewMode,
    toggleCompare,
    toggleBeforeAfter,
    openExternal,
    openLuminar,
    isLuminarRunning,
  };
}
