import React, { useState } from 'react';
import { FolderOpen, Zap } from 'lucide-react';
import { probeLumen, pickLumenCliPath } from '../services/lumenApi';
import type { AppSettings, LumenCapabilities, LumenStatus } from '../types';

/**
 * 设置弹窗的三个领域区块（FE-10：SettingsModal 拆 section）。
 *
 * 原先 515 行单文件混着三个互不相干的设置领域 + 8 个 useState。拆分后每个
 * section 自己持有**只服务于本领域**的状态：
 *   - probe / isProbing  只被 LUMEN 区块用
 *   - isSyncing          只被 LUMEN 区块用
 *   - widthHint          只被缩略图区块用
 * 这些状态原先被提到父组件、再以 props 灌下来 —— 拆回去之后父组件少了
 * 4 个 useState，且改 LUMEN 区块不会牵动 Photoshop / 缩略图两段。
 */

export const EditorPathSection: React.FC<{
  photoshopPath: string;
  onChange: (value: string) => void;
  onBrowse: () => void;
}> = ({ photoshopPath, onChange, onBrowse }) => (
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
              value={photoshopPath}
              onChange={(e) => onChange(e.target.value)}
              placeholder="例如 C:\\Program Files\\Adobe\\Photoshop.exe"
              className="focus-ring flex-1 min-w-0 bg-background-base border border-border-default rounded-md px-3 py-1.5 text-white outline-none font-mono text-[11px] focus:border-white/40"
            />
            <button
              onClick={onBrowse}
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
  </>
);

export const ThumbnailSection: React.FC<{
  width: number;
  onChange: (value: number) => void;
}> = ({ width, onChange }) => {
  /** D9：缩略图宽度越界时的失焦提示。原先提在父组件，实际只有本区块用。 */
  const [hint, setHint] = useState<string | null>(null);

  /** D9：失焦时夹取到合法范围 [100,600] 并给出提示，避免越界值静默保留。 */
  const commit = () => {
    const clamped = Math.min(600, Math.max(100, width));
    if (clamped !== width) {
      onChange(clamped);
      setHint(`已调整到允许范围 100-600 px（你输入的是 ${width}）。`);
    } else {
      setHint(null);
    }
  };

  return (
  <>
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
              value={width}
              onChange={(e) => {
                setHint(null);
                onChange(parseInt(e.target.value, 10) || 200);
              }}
              onBlur={commit}
              className="focus-ring w-28 bg-background-base border border-border-default rounded-md px-3 py-1.5 text-white outline-none font-mono text-[11px] focus:border-white/40"
            />
            <span className="text-[11px] text-white/60">100 – 600 px</span>
          </div>
          {hint && (
            <p className="text-[10px] leading-relaxed text-amber-200/80" role="status">
              {hint}
            </p>
          )}
          <p className="text-[10px] leading-relaxed text-white/60">
            数值越大越清晰，首次扫描时生成越慢。
          </p>
        </div>
  </>
  );
};

export const LumenSettingsSection: React.FC<{
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  lumenStatus?: LumenStatus | null;
  capabilities?: LumenCapabilities | null;
  effectiveSavedLumenEnabled: boolean;
  onSync?: () => Promise<number | void> | void;
  /** 成功/失败都要给用户一行结论，绝不静默。 */
  onReport?: (msg: string) => void;
  lumenStatusDisplay: string;
  showLumenStatusRow: boolean;
}> = (p) => {
  const { settings, onChange } = p;
  const { showLumenStatusRow, lumenStatusDisplay, effectiveSavedLumenEnabled, capabilities, lumenStatus } = p;
  /** 探测状态：只服务于本区块（路径一改，上一次结论即失效）。 */
  const [probe, setProbe] = useState<{ ok: boolean; text: string } | null>(null);
  const [isProbing, setIsProbing] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const setSettings = (next: AppSettings) => {
    onChange(next);
  };

  const handleBrowsePath = async () => {
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
  const handleSync = async () => {
    if (!p.onSync) return;
    setIsSyncing(true);
    try {
      const n = await p.onSync();
      p.onReport?.(
        (n ?? 0) > 0
          ? `已从 LUMEN RAW 同步 ${n} 张的评级到侧边栏。`
          : 'LUMEN RAW 侧没有需要同步的评级变化。',
      );
    } catch (e) {
      p.onReport?.(`同步评级失败：${String(e)}`);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleTest = async () => {
    setIsProbing(true);
    setProbe(null);
    try {
      const r = await probeLumen(settings.lumenCliPath);
      setProbe(
        r.available
          ? { ok: true, text: `连接成功：LUMEN RAW ${r.version ?? ''}`.trim() }
          : { ok: false, text: r.error ?? '未能连接 LUMEN RAW（请检查 lumen-cli 路径）' },
      );
    } catch (e) {
      setProbe({ ok: false, text: `测试失败：${String(e)}` });
    } finally {
      setIsProbing(false);
    }
  };
  return (
  <>
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
              onClick={handleBrowsePath}
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
              onClick={handleTest}
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

          {p.onSync && lumenStatus?.available && (
            <div className="flex flex-col gap-1.5">
              <button
                onClick={handleSync}
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
  </>
  );
};
