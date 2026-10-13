import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';
import { useToast } from '../components/Toast';
import type { AppSettings, SortOrder } from '../types';

/**
 * 全局设置：启动时读回一次，设置弹窗保存后原地更新。
 *
 * `lumenRefreshToken` 与 settings 同生命周期（N-12）：设置里改了 lumen-cli
 * 路径之后必须**强制重探**引擎握手，否则 UI 会一直显示改之前的可用性。
 * 用递增令牌而不是布尔量，是因为同一次保存可能需要触发多次重探
 * （连点两次保存），布尔量会把第二次吞掉。
 */
export function useAppSettings(onFoldersLoaded?: (s: AppSettings) => void) {
  const toast = useToast();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [lumenRefreshToken, setLumenRefreshToken] = useState(0);

  // Load initial settings and default paths on startup
  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setSettings(s);
        onFoldersLoaded?.(s);
      })
      .catch((err) => {
        // Without this the app looks healthy with settings === null, and the
        // "save folder as default" branch never runs (F-04).
        console.error('Failed to load settings:', err);
        toast.error(
          '无法读取本地设置，将使用默认值。\n如果你的默认文件夹没有自动填充，请到「设置」中重新指定。',
        );
      });
    // onFoldersLoaded 由调用方内联（lambda），每次渲染都是新引用；
    // 只在首次加载时跑一次，故刻意不把它列入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast]);

  /** 设置弹窗保存成功。N-12：顺带强制重探引擎。 */
  const applySettings = useCallback((s: AppSettings) => {
    setSettings(s);
    setLumenRefreshToken((t) => t + 1);
  }, []);

  /**
   * 扫描结束后把本次用的目录记为下次默认值。
   *
   * 失败只 `console.error`：扫描本身已经成功，不能因为「记不住默认目录」
   * 就把它报成失败。
   */
  const persistFolders = useCallback(
    (jpg: string, raw: string, sortOrder: SortOrder) => {
      if (!settings) return;
      api
        .saveSettings({
          ...settings,
          defaultJpgFolder: jpg,
          defaultRawFolder: raw,
          sortOrder,
        })
        .catch((err) => console.error('Failed to persist settings:', err));
    },
    [settings],
  );

  return { settings, applySettings, persistFolders, lumenRefreshToken };
}