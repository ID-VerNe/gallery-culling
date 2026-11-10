/**
 * 镜头快捷预设的纯逻辑（ADR-013）。
 *
 * 锁三件事：
 *  1. 脏数据只能退化成「能用的那部分」，不能把弹窗带崩；
 *  2. 空数组就是空数组 —— 用户删空之后不许复种出厂值；
 *  3. 校验给的是「下一步怎么办」，且编辑自己不算重名（否则只改光圈存不了）。
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_LENS_PRESETS,
  EMPTY_LENS_PRESET_DRAFT,
  sanitizeLensPresets,
  validateLensPresetDraft,
} from './lensPresets';

describe('sanitizeLensPresets', () => {
  it('非数组一律退化成空数组', () => {
    expect(sanitizeLensPresets(null)).toEqual([]);
    expect(sanitizeLensPresets(undefined)).toEqual([]);
    expect(sanitizeLensPresets({ name: 'X' })).toEqual([]);
    expect(sanitizeLensPresets('[]')).toEqual([]);
  });

  it('丢掉没有名字的项，其余字段 trim', () => {
    const got = sanitizeLensPresets([
      { name: '  VM 21mm  ', focal: ' 21mm ', aperture: ' f/3.5 ' },
      { name: '   ', focal: '50mm', aperture: 'f/1.4' },
      { focal: '35mm' },
      { name: 123, focal: '50mm' },
      null,
      'junk',
      42,
    ]);

    expect(got).toEqual([{ name: 'VM 21mm', focal: '21mm', aperture: 'f/3.5' }]);
  });

  it('缺字段补空串，不炸', () => {
    expect(sanitizeLensPresets([{ name: 'X 50mm' }])).toEqual([
      { name: 'X 50mm', focal: '', aperture: '' },
    ]);
  });

  it('空数组保持为空（删空后不复种出厂值）', () => {
    // 变异保护：这里若退化成 BUILTIN_LENS_PRESETS 会立刻红。
    expect(sanitizeLensPresets([])).toEqual([]);
    expect(sanitizeLensPresets([])).not.toEqual(BUILTIN_LENS_PRESETS);
  });
});

describe('validateLensPresetDraft', () => {
  const existing = [
    { name: 'Voigtlander NOKTON 35mm F1.2', focal: '35mm', aperture: 'f/1.2' },
    { name: 'Zeiss ZM 35mm F2', focal: '35mm', aperture: 'f/2.0' },
  ];

  it('名字为空（含纯空格）拒绝，并说明下一步', () => {
    const result = validateLensPresetDraft(
      { name: '   ', focal: '50mm', aperture: 'f/2' },
      existing,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('不能为空');
  });

  it('重名拒绝，且忽略大小写与首尾空格', () => {
    const result = validateLensPresetDraft(
      { name: '  zeiss zm 35mm f2 ', focal: '35mm', aperture: 'f/2.8' },
      existing,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('已经有一条');
  });

  it('编辑自己不算重名（只改光圈必须能存）', () => {
    const result = validateLensPresetDraft(
      { name: 'Zeiss ZM 35mm F2', focal: '35mm', aperture: 'f/2.8' },
      existing,
      1,
    );

    expect(result).toEqual({
      ok: true,
      preset: { name: 'Zeiss ZM 35mm F2', focal: '35mm', aperture: 'f/2.8' },
    });
  });

  it('通过时返回 trim 后的值', () => {
    const result = validateLensPresetDraft(
      { name: '  VM 21mm F3.5 ', focal: ' 21mm', aperture: 'f/3.5 ' },
      existing,
    );

    expect(result).toEqual({
      ok: true,
      preset: { name: 'VM 21mm F3.5', focal: '21mm', aperture: 'f/3.5' },
    });
  });

  it('焦段 / 光圈可以留空（有些手动头只在型号里写焦段）', () => {
    expect(
      validateLensPresetDraft({ name: 'Lensbaby Composer', focal: '', aperture: '' }, [])
        .ok,
    ).toBe(true);
  });
});

describe('出厂预设', () => {
  it('6 条全表锁死，与 Rust 侧 builtin_lens_presets() 同值同序（issue #125）', () => {
    expect(BUILTIN_LENS_PRESETS).toEqual([
      { name: 'Voigtlander APO-LANTHAR 50mm F2', focal: '50mm', aperture: 'f/2.0' },
      { name: 'Voigtlander NOKTON 35mm F1.2', focal: '35mm', aperture: 'f/1.2' },
      { name: 'TTArtisan 28mm F5.6', focal: '28mm', aperture: 'f/5.6' },
      { name: '7Artisans 35mm F0.95', focal: '35mm', aperture: 'f/0.95' },
      { name: 'Leica Summicron-M 50mm f/2', focal: '50mm', aperture: 'f/2.0' },
      { name: 'Zeiss Planar T* 50mm f/1.4', focal: '50mm', aperture: 'f/1.4' },
    ]);
  });

  it('空草稿三项皆空', () => {
    expect(EMPTY_LENS_PRESET_DRAFT).toEqual({ name: '', focal: '', aperture: '' });
  });
});
