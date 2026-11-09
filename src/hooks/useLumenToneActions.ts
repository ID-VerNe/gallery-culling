import { useCallback, useEffect } from 'react';
import { api } from '../services/api';
import { useToast } from '../components/Toast';
import { groupPath } from '../utils/groupPath';
import type { PhotoGroupInfo, ToneAdjustments } from '../types';

/**
 * LUMEN 预设 / 蒙版动作管线（issue #113：自 `useToneEditing` 按管线拆出）。
 *
 * 拥有：打开面板时读回统一状态、应用内置预设、套用 AI 蒙版、读回现有蒙版。
 * 内存编辑态（`toneMap`）与分歧标记的 state 仍由门面持有，这里只经注入的
 * 回调协同——**程序化写入走 `onToneChange`，绝不触发自动保存**（读回即写盘
 * 会在预设套用后再多写一次）。
 */
export function useLumenToneActions(opts: {
  currentGroup: PhotoGroupInfo | undefined;
  showTonalPanel: boolean;
  lumenCapsAiMasks: boolean | undefined;
  /** 用于判断「宿主是否已有本地改动」（读回时不覆盖用户刚拖的滑杆）。 */
  toneMap: Record<string, ToneAdjustments>;
  onToneChange: (tone: ToneAdjustments) => void;
  onGroupsPatched: (id: string, patch: Partial<PhotoGroupInfo>) => void;
  onMasksLoaded: (masks: Array<{ index?: number; name?: string; kind?: string }>) => void;
  onDivergentChange: (divergent: boolean) => void;
}) {
  const {
    currentGroup,
    showTonalPanel,
    lumenCapsAiMasks,
    toneMap,
    onToneChange,
    onGroupsPatched,
    onMasksLoaded,
    onDivergentChange,
  } = opts;
  const toast = useToast();

  /**
   * 打开调色面板时读回统一状态：生效值 + XMP 真值 + lumen 工程真值 + 是否分歧。
   * 引擎关闭时只读 XMP（零请求）。
   */
  useEffect(() => {
    if (!showTonalPanel || !currentGroup) {
      onDivergentChange(false);
      return;
    }
    const targetPath = groupPath(currentGroup);
    if (!targetPath) return;
    let active = true;
    api
      .getToneState(targetPath)
      .then((st) => {
        if (!active) return;
        onDivergentChange(st.divergent);
        // 只在宿主还没有本地改动时用真值回填，避免覆盖用户刚拖的滑杆
        if (!toneMap[currentGroup.id]) {
          onToneChange(st.tone);
        }
      })
      .catch((e) => console.warn('读取调色状态失败:', e));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTonalPanel, currentGroup?.id]);

  /**
   * 应用 LUMEN RAW 内置预设（编辑态是进程内 session，后端保证 apply+save 同进程）。
   * 套完用统一读取把真实值拉回来，滑杆立刻反映。
   * 返回值 = 是否真的成功（early return / catch 均为 false）：TonalAdjuster 的
   * 预设下拉靠它决定要不要把名字标记为「已套用」—— 绝不先于事实显示。
   */
  const handleApplyLumenPreset = useCallback(
    async (name: string): Promise<boolean> => {
      if (!currentGroup) return false;
      const targetPath = groupPath(currentGroup);
      if (!targetPath) return false;
      try {
        await api.applyLumenPreset(targetPath, name, 100);
        const st = await api.getToneState(targetPath);
        onGroupsPatched(currentGroup.id, { tone: st.tone });
        onToneChange(st.tone);
        onDivergentChange(st.divergent);
        toast.success(`已应用预设「${name}」。`);
        return true;
      } catch (err) {
        console.error('Failed to apply preset:', err);
        toast.error(`应用预设失败：${String(err)}`);
        return false;
      }
    },
    [currentGroup, onToneChange, toast, onGroupsPatched, onDivergentChange],
  );

  /** 套用 AI 蒙版（GPU 版实测约 4s，toast 承担进度反馈）。 */
  const handleApplyLumenMask = useCallback(
    async (region: string, dehaze: number) => {
      if (!currentGroup) return;
      const targetPath = groupPath(currentGroup);
      if (!targetPath) return;
      // 后端拒绝（引擎未启用 / 非 GPU 版 / 区域非法）会走到这里。原实现没有
      // try/catch，Promise 拒绝变成 unhandled rejection：用户看不到任何提示，
      // 面板也停在半开状态。
      try {
        const result = await api.applyLumenMask(targetPath, region, {
          exposure: 0,
          highlights: 0,
          shadows: 0,
          dehaze,
          clarity: 0,
          saturation: 0,
          temperature: 0,
        });
        onMasksLoaded(result.masks);
        toast.success(
          `已套用「${region}」蒙版（${(result.elapsedMs / 1000).toFixed(1)}s）。`,
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        toast.error(`蒙版应用失败：${reason}。请确认使用 GPU 版 LUMEN RAW。`);
      }
    },
    [currentGroup, toast, onMasksLoaded],
  );

  /** 读回工程里现有的 AI 蒙版（面板打开时）。 */
  useEffect(() => {
    if (!showTonalPanel || !currentGroup) {
      onMasksLoaded([]);
      return;
    }
    const targetPath = groupPath(currentGroup);
    if (!targetPath || !lumenCapsAiMasks) return;
    let active = true;
    api
      .listLumenMasks(targetPath)
      .then((m) => active && onMasksLoaded(m))
      // 读回失败不要静默吞掉：至少留一条 console.warn，比兄弟 getLumenCapabilities
      // /getToneState 都更不透明。完全静默会让「面板里没有蒙版」看起来像
      // 「这张图本来就没蒙版」，无法区分。
      .catch((e) => console.warn('listLumenMasks failed', e));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTonalPanel, currentGroup?.id, lumenCapsAiMasks]);

  return { handleApplyLumenPreset, handleApplyLumenMask };
}
