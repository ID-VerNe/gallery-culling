/**
 * 镜头快捷预设的纯逻辑（ADR-013）。
 *
 * 这里只做「容错解析 + 最低限度校验」，**不碰 IO**：读写都在
 * `useLensPresets` 里。分开放是为了让这些边界能在没有 IPC 的纯单测里跑。
 *
 * 一条重要口径：预设的三个字段最终会被原样写进 XMP 的镜头型号 / 焦段 / 光圈，
 * 所以除了「名字不能为空」「不要重名」之外**不做任何格式约束** —— 用户写
 * `50mm` 还是 `50`、`f/2.0` 还是 `F2`，都是他的自由，替用户改格式只会让他
 * 下次对不上自己相册里的写法。
 */
import type { LensPreset } from '../types';

/**
 * 出厂预设：与 Rust 侧 `builtin_lens_presets()` 同源同序。
 *
 * 前端这份只在**后端读失败**时兜底（例如命令没注册、库被占用），让弹窗至少
 * 还能用；正常路径下真值永远是 SQLite 里那一份。两处改动必须同步。
 */
export const BUILTIN_LENS_PRESETS: LensPreset[] = [
  { name: 'Voigtlander APO-LANTHAR 50mm F2', focal: '50mm', aperture: 'f/2.0' },
  { name: 'Voigtlander NOKTON 35mm F1.2', focal: '35mm', aperture: 'f/1.2' },
  { name: 'TTArtisan 28mm F5.6', focal: '28mm', aperture: 'f/5.6' },
  { name: '7Artisans 35mm F0.95', focal: '35mm', aperture: 'f/0.95' },
  { name: 'Leica Summicron-M 50mm f/2', focal: '50mm', aperture: 'f/2.0' },
  { name: 'Zeiss Planar T* 50mm f/1.4', focal: '50mm', aperture: 'f/1.4' },
];

/** 编辑表单的原始输入（还没 trim、还没校验）。 */
export interface LensPresetDraft {
  name: string;
  focal: string;
  aperture: string;
}

export const EMPTY_LENS_PRESET_DRAFT: LensPresetDraft = {
  name: '',
  focal: '',
  aperture: '',
};

/**
 * 容错解析：任何脏数据都退化成「能用的那部分」。
 *
 * 非数组 → `[]`（调用方自己决定要不要兜底成出厂值）；数组里的非对象项、
 * 名字为空或不是字符串的项直接丢弃；字段逐个 trim。
 *
 * **空数组是合法结果**：它代表「用户把预设全删了」，调用方不能因为拿到空
 * 就补回出厂 6 条 —— 那是「删了又自己长出来」。
 */
export function sanitizeLensPresets(input: unknown): LensPreset[] {
  if (!Array.isArray(input)) return [];

  const out: LensPreset[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!name) continue;
    out.push({
      name,
      focal: typeof record.focal === 'string' ? record.focal.trim() : '',
      aperture: typeof record.aperture === 'string' ? record.aperture.trim() : '',
    });
  }
  return out;
}

/** 校验结果：失败时给的是「下一步怎么办」，不是「校验失败」。 */
export type LensPresetValidation =
  | { ok: true; preset: LensPreset }
  | { ok: false; message: string };

/** 重名判定用的小写 key：`NOKTON 35mm` 与 `nokton 35mm ` 是同一条。 */
function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * 校验一条待新增 / 待修改的预设。
 *
 * `editingIndex` 为 null 表示新增；否则是正在编辑的那条的下标 ——
 * **编辑自己不算重名**，否则「只改光圈」会永远保存不了。
 */
export function validateLensPresetDraft(
  draft: LensPresetDraft,
  existing: LensPreset[],
  editingIndex: number | null = null,
): LensPresetValidation {
  const preset: LensPreset = {
    name: draft.name.trim(),
    focal: draft.focal.trim(),
    aperture: draft.aperture.trim(),
  };

  if (!preset.name) {
    return { ok: false, message: '镜头型号不能为空，例如「Voigtlander VM 21mm F3.5」。' };
  }

  const duplicated = existing.some(
    (item, index) => index !== editingIndex && nameKey(item.name) === nameKey(preset.name),
  );
  if (duplicated) {
    return {
      ok: false,
      message: `已经有一条叫「${preset.name}」的预设了，换个名字，或直接编辑那一条。`,
    };
  }

  return { ok: true, preset };
}
