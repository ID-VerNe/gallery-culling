/**
 * RAW-only 占位 copy 的单一真值（issue #121）。
 *
 * Preview 双分支为超集：引擎可用（解码失败）与引擎不可用（需启用）各一份文案。
 * Split / BeforeAfter 历史单分支各自写了「在此实时预览」「在此对照预览」，
 * 与 Preview 逐字不同。本文件用表驱动钉死三视口共用的双分支逐字 copy，
 * 任何一处改字 / 增删分支即红。
 */
import { describe, it, expect } from 'vitest';
import { rawOnlyEmptyState } from './viewportRawCopy';

describe('rawOnlyEmptyState —— RAW-only 占位 copy 双分支（issue #121）', () => {
  const cases = [
    {
      engineAvailable: true,
      title: 'RAW 预览暂不可用',
      description: 'LUMEN RAW 引擎未能解码该照片，请稍后重试或改用其它视图。',
    },
    {
      engineAvailable: false,
      title: '该 RAW 需启用 LUMEN RAW 引擎',
      description: '当前为 RAW-only 照片，启用 LUMEN RAW 引擎后即可实时预览；JPG 照片不受影响。',
    },
  ] as const;

  for (const { engineAvailable, title, description } of cases) {
    it(`engineAvailable=${engineAvailable} → 「${title}」`, () => {
      // 用 toEqual 钉死完整对象：改字（如给 title 加无意义前缀）会红。
      expect(rawOnlyEmptyState({ engineAvailable })).toEqual({ title, description });
    });
  }

  it('两分支互异（防两边写成同一句而表驱动不红）', () => {
    expect(rawOnlyEmptyState({ engineAvailable: true })).not.toEqual(
      rawOnlyEmptyState({ engineAvailable: false }),
    );
  });
});
