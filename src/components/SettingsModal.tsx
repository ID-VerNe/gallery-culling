import React, { useState, useEffect } from 'react';
import { Settings, FolderOpen, Save } from 'lucide-react';
import { AppSettings, LumenCapabilities, LumenStatus } from '../types';
import { api } from '../services/api';
import { open } from '@tauri-apps/plugin-dialog';
import { Modal } from './Modal';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSettingsSaved: (settings: AppSettings) => void;
  onError?: (message: string) => void;
  /** LUMEN RAW 握手状态（App 层已有，透传避免重复探测） */
  lumenStatus?: LumenStatus | null;
  /** sidecar 能力（含 aiMasks —— 按磁盘事实判定） */
  capabilities?: LumenCapabilities | null;
  /** 把 LUMEN RAW 的评级拉回侧边栏（返回被更新的文件数） */
  onSyncRatings?: (folder: string) => Promise<number>;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  onSettingsSaved,
  onError,
  lumenStatus,
  capabilities,
  onSyncRatings,
}) => {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  const handleSyncRatings = async () => {
    if (!onSyncRatings) return;
    setIsSyncing(true);
    try {
      const n = await onSyncRatings('');
      onError?.(
        n > 0
          ? `已从 LUMEN RAW 同步 ${n} 张的评级到侧边栏。`
          : 'LUMEN RAW 侧没有需要同步的评级变化。',
      );
    } catch (e) {
      onError?.(`同步评级失败：${String(e)}`);
    } finally {
      setIsSyncing(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      api.getSettings().then(setSettings).catch((e) => {
        onError?.(`读取设置失败：${String(e)}`);
      });
    }
    // `onError` is a toast callback and intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const handleBrowsePhotoshop = async () => {
    if (!settings) return;
    const selected = await open({
      multiple: false,
      title: '选择 Photoshop 可执行文件 (Photoshop.exe)',
      filters: [{ name: 'Executable', extensions: ['exe', 'app'] }],
    });
    if (typeof selected === 'string') {
      setSettings({ ...settings, photoshopPath: selected });
    }
  };

  const handleSave = async () => {
    if (!settings) return;
    setIsSaving(true);
    try {
      await api.saveSettings(settings);
      onSettingsSaved(settings);
      onClose();
    } catch (e) {
      onError?.(`保存设置失败：${String(e)}`);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="首选项与工具设置"
      maxWidth="max-w-md"
      icon={<Settings className="w-4 h-4" aria-hidden="true" />}
      footer={
        <>
          <button
            onClick={onClose}
            className="focus-ring px-3.5 py-1.5 rounded-md bg-white/5 hover:bg-white/10 active:scale-[0.96] text-white/80 transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving || !settings}
            className="focus-ring flex items-center gap-1.5 px-3.5 py-1.5 bg-white hover:bg-white/90 text-black active:scale-[0.96] disabled:bg-white/10 disabled:text-white/40 disabled:cursor-not-allowed rounded-md font-medium transition-transform shadow-sm"
          >
            <Save className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{isSaving ? '保存中…' : '保存设置'}</span>
          </button>
        </>
      }
    >
      {!settings ? (
        <p className="text-white/60 text-xs" role="status">
          正在读取设置…
        </p>
      ) : (
        <>
          {/* Photoshop Path */}
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="settings-photoshop-path"
              className="text-white/80 font-medium cursor-pointer"
            >
              Photoshop 可执行程序路径
            </label>
            <div className="flex items-center gap-2">
              <input
                id="settings-photoshop-path"
                type="text"
                value={settings.photoshopPath}
                onChange={(e) =>
                  setSettings({ ...settings, photoshopPath: e.target.value })
                }
                placeholder="例如 C:\\Program Files\\Adobe\\Photoshop.exe"
                className="focus-ring flex-1 min-w-0 bg-background-base border border-border-default rounded-md px-3 py-1.5 text-white outline-none font-mono text-[11px] focus:border-white/40"
              />
              <button
                onClick={handleBrowsePhotoshop}
                className="focus-ring px-3 py-1.5 bg-white/5 hover:bg-white/10 active:scale-[0.96] text-white rounded-md flex items-center gap-1 transition-colors shrink-0"
                title="选择 Photoshop 路径"
                aria-label="选择 Photoshop 路径"
              >
                <FolderOpen className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>
            <p className="text-[10px] leading-relaxed text-white/60">
              用于快捷键 O 或点击“外部打开”时直接通过 Photoshop 打开对应相机 RAW
              文件。留空则使用系统默认程序。
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="settings-lumen-enabled"
              className="text-white/80 font-medium cursor-pointer flex items-center gap-2"
            >
              <input
                id="settings-lumen-enabled"
                type="checkbox"
                checked={settings.lumenEnabled}
                onChange={(e) =>
                  setSettings({ ...settings, lumenEnabled: e.target.checked })
                }
                className="focus-ring w-4 h-4 accent-white"
              />
              启用 LUMEN RAW 引擎（RAW 真实解码预览）
            </label>
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="settings-lumen-path"
              className="text-white/80 font-medium cursor-pointer"
            >
              lumen-cli.exe 路径
            </label>
            <input
              id="settings-lumen-path"
              type="text"
              value={settings.lumenCliPath}
              onChange={(e) =>
                setSettings({ ...settings, lumenCliPath: e.target.value })
              }
              placeholder="留空 = 自动查找已安装的 LUMEN RAW"
              className="focus-ring w-full bg-background-base border border-border-default rounded-md px-3 py-1.5 text-white outline-none font-mono text-[11px] focus:border-white/40"
            />
            <p className="text-[10px] leading-relaxed text-white/60">
              开启后，RAW 预览会通过 LUMEN RAW 解码并应用显影曲线；引擎不可用时
              自动回退到相机内嵌预览，不影响选片。
            </p>

            {/* 引擎握手状态（只读，来自 lumen_status_cmd 的缓存） */}
            {settings.lumenEnabled && (
              <p
                className="text-[10px] leading-relaxed text-white/60"
                role="status"
                aria-live="polite"
              >
                {lumenStatus?.available
                  ? `已连接 LUMEN RAW ${lumenStatus.foundVersion ?? ''}`.trim()
                  : (lumenStatus?.detail ?? '正在探测引擎…')}
              </p>
            )}

            <div className="flex flex-col gap-1.5 pt-1">
              <label
                htmlFor="settings-lumen-grid"
                className="text-white/80 font-medium cursor-pointer flex items-center gap-2"
              >
                <input
                  id="settings-lumen-grid"
                  type="checkbox"
                  checked={settings.lumenGridThumbnails}
                  disabled={!settings.lumenEnabled}
                  onChange={(e) =>
                    setSettings({ ...settings, lumenGridThumbnails: e.target.checked })
                  }
                  className="focus-ring w-4 h-4 accent-white disabled:opacity-40"
                />
                宫格缩略图也用 LUMEN RAW 渲染
              </label>
              <p className="text-[10px] leading-relaxed text-white/60">
                关闭时宫格用相机内嵌缩略图（近乎零成本）；开启后每张约 0.3 秒，
                好处是宫格与大图显影一致。
              </p>
            </div>

            {/* AI（GPU 版）入口：勾选后若指向的是 CPU 版，明确警告而不是等点下去 */}
            <div className="flex flex-col gap-1.5 pt-1">
              <label
                htmlFor="settings-lumen-expect-ai"
                className="text-white/80 font-medium cursor-pointer flex items-center gap-2"
              >
                <input
                  id="settings-lumen-expect-ai"
                  type="checkbox"
                  checked={settings.lumenExpectAi}
                  disabled={!settings.lumenEnabled}
                  onChange={(e) =>
                    setSettings({ ...settings, lumenExpectAi: e.target.checked })
                  }
                  className="focus-ring w-4 h-4 accent-white disabled:opacity-40"
                />
                我指向的是 GPU / AI 版（启用 AI 蒙版）
              </label>
              <p className="text-[10px] leading-relaxed text-white/60">
                AI 蒙版需要带 onnxruntime 与模型的构建（体积约 487MB）。
                勾选后若当前路径是 CPU 版，这里会直接提示，不会让你在保存调色时才发现。
              </p>
              {settings.lumenExpectAi && capabilities && !capabilities.aiMasks && (
                <p
                  role="status"
                  className="text-[10px] leading-relaxed text-amber-200/80 rounded-md border border-amber-200/25 px-2 py-1.5"
                >
                  你勾选了 GPU 版，但当前路径探测不到 AI 模型与 onnxruntime —— AI 蒙版
                  在这张照片上不可用。请把 lumen-cli 路径改到 GPU 版，或取消勾选。
                </p>
              )}
            </div>

            {onSyncRatings && lumenStatus?.available && (
              <div className="flex flex-col gap-1.5">
                <button
                  onClick={handleSyncRatings}
                  disabled={isSyncing}
                  className="focus-ring flex items-center justify-center gap-1.5 py-2 px-3 bg-white/5 hover:bg-white/10 active:scale-[0.98] text-white rounded-md text-xs transition-colors disabled:opacity-50"
                  title="从 LUMEN RAW 拉取该文件夹的星级/旗标并写回 .xmp"
                >
                  {isSyncing ? '同步中…' : '从 LUMEN RAW 同步评级'}
                </button>
                <p className="text-[10px] leading-relaxed text-white/60">
                  你在 LUMEN RAW 里改过的星级/旗标会写回侧边栏；本机改动不会被
                  静默覆盖（两侧都改过时会跳过并提示）。
                </p>
              </div>
            )}
          </div>

          {/* Thumbnail Width */}
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="settings-thumbnail-width"
              className="text-white/80 font-medium cursor-pointer"
            >
              缩略图默认生成尺寸（宽度像素）
            </label>
            <div className="flex items-center gap-3">
              <input
                id="settings-thumbnail-width"
                type="number"
                min={100}
                max={600}
                step={50}
                value={settings.thumbnailWidth}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    thumbnailWidth: parseInt(e.target.value, 10) || 200,
                  })
                }
                className="focus-ring w-28 bg-background-base border border-border-default rounded-md px-3 py-1.5 text-white outline-none font-mono text-[11px] focus:border-white/40"
              />
              <span className="text-[11px] text-white/60">100 – 600 px</span>
            </div>
            <p className="text-[10px] leading-relaxed text-white/60">
              数值越大越清晰，首次扫描时生成越慢。
            </p>
          </div>
        </>
      )}
    </Modal>
  );
};
