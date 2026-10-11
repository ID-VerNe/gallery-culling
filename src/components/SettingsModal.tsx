import React, { useState, useEffect } from 'react';
import { Settings, FolderOpen, Save } from 'lucide-react';
import { AppSettings } from '../types';
import { api } from '../services/api';
import { open } from '@tauri-apps/plugin-dialog';
import { Modal } from './Modal';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSettingsSaved: (settings: AppSettings) => void;
  onError?: (message: string) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  onSettingsSaved,
  onError,
}) => {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [isSaving, setIsSaving] = useState(false);

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
