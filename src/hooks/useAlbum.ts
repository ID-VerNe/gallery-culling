/**
 * FR-10 前端：选片集的保存与打开。
 *
 * 边界：
 * - **格式解析归 `utils/albumGroups`**（纯函数，逐条单测），本 hook 只管
 *   「问用户要路径 → 调命令 → 报结果 → 把集合交出去」；
 * - **不自己改集合**：`onLoaded` 由宿主接线，因为替换集合要连带清撤销栈、
 *   清多选、重置选中位置，那是 App 层才知道的事；
 * - **失败绝不清空当前视图**：打开失败时用户手上还有照片，替他把视图清掉
 *   等于用一次失败换一次数据丢失。
 *
 * 两条静默规则：
 * - 用户在文件对话框里点了取消 → 什么都不说（取消不是错误）；
 * - 保存成功没有缺失报告（保存不产生报告）。
 */
import { useCallback, useRef, useState } from 'react';
import { api } from '../services/api';
import { useToast } from '../components/Toast';
import { useTaskMutex } from './useTaskMutex';
import { toAlbumGroups, type AlbumLoad } from '../utils/albumGroups';
import type { AlbumItemInput, AlbumOpenResult } from '../types';

export interface UseAlbumOptions {
  /**
   * 打开成功：把解析结果交给宿主替换集合。
   *
   * `tones` 必须一起用 `toneSeed` 灌进去 —— 少了它调色面板显示全 0，
   * 用户点一下保存就把真实调色覆盖成 0。
   */
  onLoaded: (load: AlbumLoad, albumPath: string) => void;
}

export interface AlbumApi {
  /** 当前集合来自哪个选片集（`null` = 不是从选片集打开的）。扫描后清空。 */
  path: string | null;
  saving: boolean;
  opening: boolean;
  /** 上一次打开留下的缺失报告；`null` = 没有（或已关闭）。 */
  report: AlbumOpenResult | null;
  /**
   * 存为选片集。返回是否真的写盘了（取消 / 被互斥挡住 / 没有照片 → false）。
   * 成功后**不改 `path`**：用户此刻看的仍是原来的目录，把他标成「正在看选片集」
   * 会让顶栏的目录框与照片列表互相矛盾。
   */
  saveAs: (items: AlbumItemInput[], defaultPath?: string) => Promise<boolean>;
  /**
   * 打开选片集。返回结果用于决定要不要把缺失报告留在屏幕上；
   * `null` = 取消 / 失败 / 被互斥挡住（视图保持原样）。
   */
  open: () => Promise<AlbumOpenResult | null>;
  dismissReport: () => void;
  /** 换数据源（扫描）时清掉选片集身份。 */
  clear: () => void;
}

function baseNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function useAlbum({ onLoaded }: UseAlbumOptions): AlbumApi {
  const toast = useToast();
  const mutex = useTaskMutex();

  const [path, setPath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [opening, setOpening] = useState(false);
  const [report, setReport] = useState<AlbumOpenResult | null>(null);

  /** 重入保护：文件对话框是模态的，但连点两下仍可能排两次。 */
  const busyRef = useRef(false);

  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  const saveAs = useCallback(
    async (items: AlbumItemInput[], defaultPath?: string): Promise<boolean> => {
      if (busyRef.current) return false;
      if (items.length === 0) {
        toast.info('当前没有可保存的照片。先扫描目录，或调整筛选范围。');
        return false;
      }
      if (!mutex.canStart('album')) {
        toast.info(mutex.blockReason('album') ?? '现在不能保存选片集。');
        return false;
      }

      let target: string | null;
      try {
        target = await api.selectAlbumSavePath(defaultPath);
      } catch (err) {
        toast.error(`无法打开保存对话框：${String(err)}`);
        return false;
      }
      // 取消不是错误 —— 静默返回。
      if (!target) return false;

      busyRef.current = true;
      setSaving(true);
      const release = mutex.begin('album');
      try {
        const res = await api.saveAlbum(target, items);
        setReport(null);
        toast.success(`已保存 ${res.saved} 张到 ${baseNameOf(res.path)}。`);
        return true;
      } catch (err) {
        console.error('save_album_cmd failed:', err);
        toast.error(`保存选片集失败：${String(err)}`);
        return false;
      } finally {
        release();
        busyRef.current = false;
        setSaving(false);
      }
    },
    [mutex, toast],
  );

  const open = useCallback(async (): Promise<AlbumOpenResult | null> => {
    if (busyRef.current) return null;
    if (!mutex.canStart('album')) {
      toast.info(mutex.blockReason('album') ?? '现在不能打开选片集。');
      return null;
    }

    let target: string | null;
    try {
      // 上一次打开的目录作为起点：连着开同一个项目的几本选片集是常态。
      target = await api.selectAlbumOpenPath(path ?? undefined);
    } catch (err) {
      toast.error(`无法打开文件对话框：${String(err)}`);
      return null;
    }
    if (!target) return null;

    busyRef.current = true;
    setOpening(true);
    const release = mutex.begin('album');
    try {
      const res = await api.openAlbum(target);
      const load = toAlbumGroups(res);
      // 先交集合再报结果：报告里的缺失项要对着**新**集合看才有意义。
      onLoadedRef.current(load, res.path);
      setPath(res.path);
      setReport(res.missing > 0 ? res : null);

      if (res.missing > 0) {
        toast.info(
          `已打开 ${load.groups.length} 张，${res.missing} 张找不到（列表见「选片集」）。`,
        );
      } else {
        toast.success(`已打开选片集 ${baseNameOf(res.path)}，共 ${load.groups.length} 张。`);
      }
      return res;
    } catch (err) {
      // 失败**不动**当前集合：用户手上的照片不该因为一次打不开的选片集消失。
      console.error('open_album_cmd failed:', err);
      toast.error(`打开选片集失败：${String(err)}`);
      return null;
    } finally {
      release();
      busyRef.current = false;
      setOpening(false);
    }
  }, [mutex, path, toast]);

  const dismissReport = useCallback(() => setReport(null), []);

  const clear = useCallback(() => {
    setPath(null);
    setReport(null);
  }, []);

  return { path, saving, opening, report, saveAs, open, dismissReport, clear };
}
