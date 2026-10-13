import React, { useState, useEffect, useRef } from 'react';
import { Settings, FolderOpen, Save, Zap } from 'lucide-react';
import { AppSettings, LumenCapabilities, LumenStatus } from '../types';
import { api } from '../services/api';
import { probeLumen, pickLumenCliPath } from '../services/lumenApi';
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
  const [isSyncing, setIsSyncing] = useState(false);
  /** 加载成功时的基线快照 —— 用于脏检查。 */
  const loadedRef = useRef<AppSettings | null>(null);
  /** 「放弃未保存的更改？」确认弹窗。 */
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** 「测试连接」的结果（null = 尚未测试）。ok 决定配色，text 是给用户看的一行结论。 */
  const [probe, setProbe] = useState<{ ok: boolean; text: string } | null>(null);
  const [isProbing, setIsProbing] = useState(false);
  /** D3：读取设置失败的原始错误；非 null 时渲染错误态 + 「重试」。 */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** D9：缩略图宽度越界时的失焦提示。 */
  const [widthHint, setWidthHint] = useState<string | null>(null);

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

  /** M-15：与 Photoshop 路径同款的「浏览」——手打长路径易错（空格/中文用户名）。 */
  const handleBrowseLumen = async () => {
    if (!settings) return;
    const selected = await pickLumenCliPath();
    if (selected) {
      setSettings({ ...settings, lumenCliPath: selected });
      // 路径已变，旧的探测结论不再可信 —— 清掉，避免用户拿旧结论决策。
      setProbe(null);
    }
  };

  /**
   * M-15：「测试连接」探测的是**输入框里尚未保存的路径**（这正是新增
   * `probe_lumen_cmd` 的价值）。成功/失败都写成一行可读结论，绝不静默。
   */
  const handleTestLumen = async () => {
    if (!settings) return;
    setIsProbing(true);
    setProbe(null);
    try {
      const r = await probeLumen(settings.lumenCliPath);
      if (r.available) {
        setProbe({
          ok: true,
          text: `连接成功：LUMEN RAW ${r.version ?? ''}`.trim(),
        });
      } else {
        setProbe({ ok: false, text: r.error ?? '未能连接 LUMEN RAW（请检查 lumen-cli 路径）' });
      }
    } catch (e) {
      setProbe({ ok: false, text: `测试失败：${String(e)}` });
    } finally {
      setIsProbing(false);
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

  /** D9：缩略图宽度失焦时夹取到合法范围 [100,600] 并给出提示，避免越界值静默保留。 */
  const commitThumbnailWidth = () => {
    if (!settings) return;
    const { thumbnailWidth } = settings;
    const clamped = Math.min(600, Math.max(100, thumbnailWidth));
    if (clamped !== thumbnailWidth) {
      setSettings({ ...settings, thumbnailWidth: clamped });
      setWidthHint(`已调整到允许范围 100–600 px（你输入的是 ${thumbnailWidth}）。`);
    } else {
      setWidthHint(null);
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
                className="focus-ring px-3 py-1.5 bg-background-surface-hover hover:bg-white/10 active:scale-[0.96] text-white rounded-md flex items-center gap-1 transition-colors shrink-0"
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
            <div className="flex items-center gap-2">
              <input
                id="settings-lumen-path"
                type="text"
                value={settings.lumenCliPath}
                onChange={(e) => {
                  setSettings({ ...settings, lumenCliPath: e.target.value });
                  // 路径一改，上一次的探测结论就失效了。
                  setProbe(null);
                }}
                placeholder="留空 = 自动查找已安装的 LUMEN RAW"
                className="focus-ring flex-1 min-w-0 bg-background-base border border-border-default rounded-md px-3 py-1.5 text-white outline-none font-mono text-[11px] focus:border-white/40"
              />
              <button
                onClick={handleBrowseLumen}
                className="focus-ring px-3 py-1.5 bg-background-surface-hover hover:bg-white/10 active:scale-[0.96] text-white rounded-md flex items-center gap-1 transition-colors shrink-0"
                title="选择 lumen-cli 路径"
                aria-label="选择 lumen-cli 路径"
              >
                <FolderOpen className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>
            <p
              className="text-[10px] leading-relaxed text-white/60"
              title="RAW 预览会通过 LUMEN RAW 解码并应用显影曲线；引擎不可用时自动回退到相机内嵌预览，不影响选片。"
            >
              开启后 RAW 预览走 LUMEN 解码；不可用时自动回退相机内嵌预览。
            </p>

            {/* M-15：「测试连接」用输入框里的路径实测（未保存也生效）。 */}
            <div className="flex items-center gap-2">
              <button
                onClick={handleTestLumen}
                disabled={isProbing}
                className="focus-ring flex items-center gap-1.5 px-3 py-1.5 bg-background-surface-hover hover:bg-white/10 active:scale-[0.96] text-white rounded-md text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="用当前输入框里的路径探测引擎是否可用"
                aria-label="测试 LUMEN RAW 连接"
              >
                <Zap className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{isProbing ? '测试中…' : '测试连接'}</span>
              </button>
            </div>
            {probe && (
              <p
                role="status"
                aria-live="polite"
                className={`text-[10px] leading-relaxed rounded-md border px-2 py-1.5 ${
                  probe.ok
                    ? 'text-emerald-200/90 border-emerald-200/25'
                    : 'text-rose-200/90 border-rose-200/25'
                }`}
              >
                {probe.text}
              </p>
            )}

            {/* 引擎握手状态（只读，来自 lumen_status_cmd 的缓存）。
                门控用「已保存 || 本地勾选」：本地新勾上时也要出现，但要标注
                「保存后生效」而不是显示已保存配置的死文案。 */}
            {showLumenStatusRow && (
              <p
                className="text-[10px] leading-relaxed text-white/60"
                role="status"
                aria-live="polite"
              >
                {lumenStatusDisplay}
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
              <p
                className="text-[10px] leading-relaxed text-white/60"
                title="关闭时宫格用相机内嵌缩略图（近乎零成本）；开启后每张约 0.3 秒，好处是宫格与大图显影一致。"
              >
                关闭用内嵌缩略图（快）；开启与大图显影一致（每张约 0.3 秒）。
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
              <p
                className="text-[10px] leading-relaxed text-white/60"
                title="勾选后若当前路径是 CPU 版，这里会直接提示，不会让你在保存调色时才发现。"
              >
                AI 蒙版需要带 onnxruntime 与模型的构建（体积约 487MB）。
              </p>
              {settings.lumenExpectAi &&
                effectiveSavedLumenEnabled &&
                capabilities &&
                !capabilities.aiMasks && (
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
                  className="focus-ring flex items-center justify-center gap-1.5 py-2 px-3 bg-background-surface-hover hover:bg-white/10 active:scale-[0.98] text-white rounded-md text-xs transition-colors disabled:opacity-50"
                  title="从 LUMEN RAW 拉取该文件夹的星级/旗标并写回 .xmp"
                >
                  {isSyncing ? '同步中…' : '从 LUMEN RAW 同步评级'}
                </button>
                <p
                  className="text-[10px] leading-relaxed text-white/60"
                  title="你在 LUMEN RAW 里改过的星级/旗标会写回侧边栏；本机改动不会被静默覆盖（两侧都改过时会跳过并提示）。"
                >
                  两侧都改过时会跳过并提示，不会被静默覆盖。
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
                onChange={(e) => {
                  setWidthHint(null);
                  setSettings({
                    ...settings,
                    thumbnailWidth: parseInt(e.target.value, 10) || 200,
                  });
                }}
                onBlur={commitThumbnailWidth}
                className="focus-ring w-28 bg-background-base border border-border-default rounded-md px-3 py-1.5 text-white outline-none font-mono text-[11px] focus:border-white/40"
              />
              <span className="text-[11px] text-white/60">100 – 600 px</span>
            </div>
            {widthHint && (
              <p className="text-[10px] leading-relaxed text-amber-200/80" role="status">
                {widthHint}
              </p>
            )}
            <p className="text-[10px] leading-relaxed text-white/60">
              数值越大越清晰，首次扫描时生成越慢。
            </p>
          </div>
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
