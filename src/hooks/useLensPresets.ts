/**
 * 镜头快捷预设的读写（ADR-013）。
 *
 * 三条口径，都是踩过的坑：
 *
 * 1. **先写库、成功再更新内存**。反过来（乐观更新 + 失败回滚）会在失败瞬间
 *    让界面短暂显示一条并不存在的预设，用户接着点它，填进表单的是一条库里
 *    没有的镜头。
 * 2. **读失败退回出厂 6 条**，不把弹窗变成错误页 —— 预设是「顺手一点」的便利
 *    功能，不该因为它挂了就没法改镜头元数据。
 * 3. **空数组不是异常**：用户把预设全删了就该是空的，绝不自动补回默认值。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { BUILTIN_LENS_PRESETS, sanitizeLensPresets } from '../utils/lensPresets';
import type { LensPreset } from '../types';

export function useLensPresets(
  isOpen: boolean,
  onError?: (message: string) => void,
) {
  const [presets, setPresets] = useState<LensPreset[]>(BUILTIN_LENS_PRESETS);
  const [isSaving, setIsSaving] = useState(false);
  /** 写盘互斥：连点两下「添加」不能把同一条提交两次。 */
  const savingRef = useRef(false);

  // 每次打开都重读：用户可能在「编辑预设」和别的窗口之间来回切。
  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    api
      .getLensPresets()
      .then((raw) => {
        if (!cancelled) setPresets(sanitizeLensPresets(raw));
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to load lens presets:', err);
        setPresets(BUILTIN_LENS_PRESETS);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  /**
   * 覆盖写入。成功返回 true（调用方据此决定要不要清空表单）。
   *
   * 失败时**不动内存里的旧列表**，只报错：界面与库始终保持一致，
   * 用户输入的内容还留在表单里，可以直接重试。
   */
  const persist = useCallback(
    async (next: LensPreset[]): Promise<boolean> => {
      if (savingRef.current) return false;
      savingRef.current = true;
      setIsSaving(true);
      try {
        await api.saveLensPresets(next);
        setPresets(next);
        return true;
      } catch (err) {
        onError?.(`保存镜头预设失败：${String(err)}。预设未改动，请重试。`);
        return false;
      } finally {
        savingRef.current = false;
        setIsSaving(false);
      }
    },
    [onError],
  );

  const addPreset = useCallback(
    (preset: LensPreset) => persist([...presets, preset]),
    [persist, presets],
  );

  const updatePreset = useCallback(
    (index: number, preset: LensPreset) =>
      persist(presets.map((item, i) => (i === index ? preset : item))),
    [persist, presets],
  );

  const removePreset = useCallback(
    (index: number) => persist(presets.filter((_, i) => i !== index)),
    [persist, presets],
  );

  /** 恢复出厂 6 条。调用方必须先做一次二次确认 —— 这会把用户的列表整个换掉。 */
  const restoreDefaults = useCallback(
    () => persist([...BUILTIN_LENS_PRESETS]),
    [persist],
  );

  return { presets, isSaving, addPreset, updatePreset, removePreset, restoreDefaults };
}
