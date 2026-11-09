/**
 * issue #115 · PB：预设成组 hook。
 *
 * 三件套必须同组迁移（不拆）：
 * - `appliedPreset`：已成功套用的预设名，只在 resolve `true` 后写入，
 *   失败/取消一律不改（显示永远对应「确实写进了这张照片的 .lumen」）；
 * - `presetPhotoId`：上一次渲染的 photoId，换照片同帧清掉 appliedPreset
 *   （免闪一帧旧名）；
 * - `applySeqRef`：连续套用的序号仲裁，迟到的旧结果不许覆盖新选择。
 *
 * 另有 `pendingPreset`（C4 二次确认的待确认名）附在该组内，因为
 * `handleConfirmPreset`（原 TonalAdjuster:289-295）读的就是它。
 */
import { useRef, useState } from 'react';

export interface UseAppliedPresetOptions {
  photoId?: string;
  onApplyPreset?: (name: string) => Promise<boolean> | boolean;
}

export interface UseAppliedPresetResult {
  /** 已成功套用的预设名（下拉框显示用）。 */
  appliedPreset: string | null;
  /** 待二次确认的预设名（C4）。 */
  pendingPreset: string | null;
  requestPreset: (name: string) => void;
  cancelPendingPreset: () => void;
  confirmPreset: () => Promise<void>;
}

export function useAppliedPreset({
  photoId,
  onApplyPreset,
}: UseAppliedPresetOptions): UseAppliedPresetResult {
  /**
   * 已成功套用的预设名（下拉框显示用）。只在下发链路 resolve `true` 后写入，
   * 失败/取消一律不改 —— 显示的名字永远对应「确实写进了这张照片的 .lumen」。
   */
  const [appliedPreset, setAppliedPreset] = useState<string | null>(null);
  const [pendingPreset, setPendingPreset] = useState<string | null>(null);
  /** 上一次渲染的 photoId：换照片的同一帧就清掉 appliedPreset（免闪一帧旧名）。 */
  const [presetPhotoId, setPresetPhotoId] = useState(photoId);
  if (presetPhotoId !== photoId) {
    setPresetPhotoId(photoId);
    setAppliedPreset(null);
  }
  /** 连续套用的序号：迟到的旧结果不许覆盖新选择（与 Bug B 同类：异步结果不得翻转用户最新动作）。 */
  const applySeqRef = useRef(0);

  const requestPreset = (name: string) => {
    setPendingPreset(name);
  };

  const cancelPendingPreset = () => {
    setPendingPreset(null);
  };

  /**
   * 预设二次确认（C4）后的真正下发。「已套用」标记只在成功（resolve true）
   * 后写入：失败时 hook 侧已有 toast 报错，这里绝不让名字先于事实出现。
   * 序号仲裁：前一次还在飞行时又确认了新的，迟到的旧结果被丢弃 ——
   * 显示永远以用户最后一次确认为准。
   */
  const confirmPreset = async () => {
    const name = pendingPreset;
    if (!name) return;
    const seq = ++applySeqRef.current;
    const ok = await onApplyPreset?.(name);
    if (seq === applySeqRef.current && ok) setAppliedPreset(name);
  };

  return {
    appliedPreset,
    pendingPreset,
    requestPreset,
    cancelPendingPreset,
    confirmPreset,
  };
}
