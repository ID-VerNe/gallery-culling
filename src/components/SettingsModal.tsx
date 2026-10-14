import React, { useState, useEffect, useRef } from 'react';
import { Settings, Save } from 'lucide-react';
import { EditorPathSection, LumenSettingsSection, ThumbnailSection } from './SettingsSections';
import { AppSettings, LumenCapabilities, LumenStatus } from '../types';
import { api } from '../services/api';
import { open } from '@tauri-apps/plugin-dialog';
import { Modal } from './Modal';
import { ConfirmDialog } from './ConfirmDialog';

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
  /**
   * App 侧**已保存**的 `lumenEnabled` 真值。
   * 状态行与 GPU 能力警告都以它为准（能力探测只对已保存配置有意义），
   * 避免"本地刚勾上、尚未保存"时冒出与勾选矛盾的死文案。
   * 缺省时退回本地值（保持向后兼容）。
   */
  savedLumenEnabled?: boolean;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  onSettingsSaved,
  onError,
  lumenStatus,
  capabilities,
  onSyncRatings,
  savedLumenEnabled,
}) => {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  /** 加载成功时的基线快照 —— 用于脏检查。 */
  const loadedRef = useRef<AppSettings | null>(null);
  /** 「放弃未保存的更改？」确认弹窗。 */
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** D3：读取设置失败的原始错误；非 null 时渲染错误态 + 「重试」。 */
  const [loadError, setLoadError] = useState<string | null>(null);

  /** 读取设置：成功 → 载入表单；失败 → 记录错误，交由 UI 渲染「重试」。 */
  const loadSettings = () => {
    setLoadError(null);
    setSettings(null);
    api
      .getSettings()
      .then((s) => {
        setSettings(s);
        // 基线快照：AppSettings 九个字段全是原始类型，浅拷贝即可用于逐键比较。
        loadedRef.current = { ...s };
      })
      .catch((e) => {
        // D3：失败必须可重试 —— 不能永远停在「正在读取设置…」。
        setLoadError(String(e));
        onError?.(`读取设置失败：${String(e)}`);
      });
  };

  useEffect(() => {
    if (isOpen) loadSettings();
    // `onError` is a toast callback and intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const isDirty =
    settings != null &&
    loadedRef.current != null &&
    (Object.keys(settings) as (keyof AppSettings)[]).some(
      (k) => settings[k] !== loadedRef.current![k],
    );

  /**
   * 所有关闭路径（取消 / X / Esc）都走这里：脏则先确认，未脏直接关。
   * 保存成功那条路不经此处——`handleSave` 自己调用 `onClose`。
   */
  const requestClose = () => {
    if (isDirty) setConfirmOpen(true);
    else onClose();
  };

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

  // M-06：状态行的「门控」与「数据源」统一到同一份真值。
  // `savedLumenEnabled` 缺省时退回本地值（向后兼容）。
  const effectiveSavedLumenEnabled =
    savedLumenEnabled ?? settings?.lumenEnabled ?? false;
  /** 本地勾选与已保存值不一致 —— 状态行文案要标注「保存后生效」。 */
  const lumenEnabledPending =
    settings != null && settings.lumenEnabled !== effectiveSavedLumenEnabled;
  const showLumenStatusRow =
    settings != null &&
    (effectiveSavedLumenEnabled || settings.lumenEnabled);
  const lumenStatusText = lumenStatus?.available
    ? `已连接 LUMEN RAW ${lumenStatus.foundVersion ?? ''}`.trim()
    : lumenStatus?.detail ?? '正在探测引擎…';
  const lumenStatusDisplay = lumenEnabledPending
    ? `${lumenStatusText}（保存后生效）`
    : lumenStatusText;

  return (
    <>
    <Modal
      isOpen={isOpen}
      onClose={requestClose}
      title="设置"
      maxWidth="max-w-md"
      icon={<Settings className="w-4 h-4" aria-hidden="true" />}
      footer={
        <>
          <button
            onClick={requestClose}
            className="focus-ring px-3.5 py-1.5 rounded-md bg-background-surface-hover hover:bg-white/10 active:scale-[0.96] text-white/80 transition-colors"
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
      {loadError !== null ? (
        // D3：读取失败 → 可读错误 + 「重试」，不再永久停在加载态。
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-lg border border-rose-800/50 bg-rose-950/30 p-3 text-rose-200/90"
        >
          <p className="text-xs leading-relaxed">读取设置失败：{loadError}</p>
          <button
            type="button"
            onClick={loadSettings}
            className="focus-ring px-3 py-1.5 rounded-md bg-background-surface-hover hover:bg-white/10 active:scale-[0.96] text-white/80 transition-colors"
          >
            重试
          </button>
        </div>
      ) : !settings ? (
        <p className="text-white/60 text-xs" role="status">
          正在读取设置…
        </p>
      ) : (
        <>
          <EditorPathSection
            photoshopPath={settings.photoshopPath}
            onChange={(v) => setSettings({ ...settings, photoshopPath: v })}
            onBrowse={handleBrowsePhotoshop}
          />

          <LumenSettingsSection
            settings={settings}
            onChange={setSettings}
            lumenStatus={lumenStatus}
            capabilities={capabilities}
            effectiveSavedLumenEnabled={effectiveSavedLumenEnabled}
            onSync={onSyncRatings ? () => onSyncRatings('') : undefined}
            onReport={onError}
            lumenStatusDisplay={lumenStatusDisplay}
            showLumenStatusRow={showLumenStatusRow}
          />

          <ThumbnailSection
            width={settings.thumbnailWidth}
            onChange={(v) => setSettings({ ...settings, thumbnailWidth: v })}
          />
        </>
      )}
    </Modal>
    <ConfirmDialog
      isOpen={confirmOpen}
      onClose={() => setConfirmOpen(false)}
      onConfirm={onClose}
      title="放弃未保存的更改？"
      message="你对设置所做的修改尚未保存。放弃这些更改并关闭？"
      confirmLabel="放弃更改"
      cancelLabel="继续编辑"
      destructive
    />
    </>
  );
};
