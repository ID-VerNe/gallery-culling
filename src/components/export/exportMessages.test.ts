/**
 * 导出文案工厂的契约测试。
 *
 * 这些句子是用户判断「有没有真的写盘」的唯一依据，所以逐字锁死：
 *  - copy 模式必须与重构前完全一致（避免无谓的行为变更）；
 *  - render 模式只换名词与动词，句式结构保持一致；
 *  - 部分失败永远走 partialTitle + failed=true，取消永远 failed=false。
 *
 * 「原片复制 —— 与重构前逐字兼容」那一组是 Step 4 纯重构的安全网：
 * 它们与 `BatchExportModal.test.tsx` 里锁死的断言同源，任何一处改动都会双红。
 */
import { describe, it, expect } from 'vitest';
import {
  buildOutcomeMessage,
  buildValidationMessage,
  buildJpegSourceWarning,
} from './exportMessages';
import { clampQuality, DEFAULT_RENDER_QUALITY } from './exportConfig';
import type { ExportOutcome } from '../../types';

const outcome = (patch: Partial<ExportOutcome> = {}): ExportOutcome => ({
  exported: 0,
  skipped: 0,
  failed: [],
  ...patch,
});

describe('buildOutcomeMessage —— 原片复制（与重构前逐字兼容）', () => {
  it('全部成功：结果条沿用既有措辞，且不再弹重复 Toast', () => {
    const r = buildOutcomeMessage({
      mode: 'copy',
      outcome: outcome({ exported: 3 }),
      targetFolder: 'D:/out',
    });
    expect(r.failed).toBe(false);
    expect(r.message).toBe('导出完成：已导出 3 个。（目标：D:/out）');
    // 结果条就在弹窗里、与用户视线同一屏，再弹一条同义 Toast 是纯噪音
    expect(r.toast).toBeNull();
    expect(r.failures).toEqual([]);
    expect(r.folder).toBe('D:/out');
  });

  it('部分失败：失败数在最前，跳过带原因说明，Toast 只否定「完全」', () => {
    const r = buildOutcomeMessage({
      mode: 'copy',
      outcome: outcome({
        exported: 2,
        skipped: 1,
        failed: [{ path: '/x/a.NEF', reason: '拒绝访问' }],
      }),
      targetFolder: 'D:/out',
    });
    expect(r.failed).toBe(true);
    expect(r.message).toContain(
      '导出未完全成功：失败 1 个 · 已导出 2 个 · 跳过 1 个（目标已存在同名文件）',
    );
    expect(r.message).toContain('/x/a.NEF（拒绝访问）');
    expect(r.toast).toEqual({
      kind: 'error',
      text: '导出未完全成功：失败 1 个，成功 2 个',
    });
  });

  it('失败明细超过 3 条时截断并带「等」', () => {
    const failed = Array.from({ length: 5 }, (_, i) => ({
      path: `/x/${i}.NEF`,
      reason: '拒绝访问',
    }));
    const r = buildOutcomeMessage({
      mode: 'copy',
      outcome: outcome({ exported: 0, failed }),
      targetFolder: 'D:/out',
    });
    expect(r.message).toContain('/x/2.NEF');
    expect(r.message).not.toContain('/x/3.NEF');
    expect(r.message).toContain('等');
    // 正文截断了，但 failures 必须是全量 —— 否则结果条的展开区无从渲染
    expect(r.failures).toHaveLength(5);
  });

  it('跳过但不失败：仍算成功，且不弹 Toast', () => {
    const r = buildOutcomeMessage({
      mode: 'copy',
      outcome: outcome({ exported: 1, skipped: 2 }),
      targetFolder: 'D:/out',
    });
    expect(r.failed).toBe(false);
    expect(r.message).toContain('跳过 2 个');
    expect(r.toast).toBeNull();
  });

  it('取消：不写「已导出」，宾语是「任何文件」，且不弹 Toast', () => {
    const r = buildOutcomeMessage({
      mode: 'copy',
      outcome: outcome({ cancelled: true }),
      targetFolder: 'D:/out',
    });
    expect(r.failed).toBe(false);
    expect(r.message).toBe('已取消导出：目标目录未产生任何文件。（目标：D:/out）');
    expect(r.message).not.toContain('已导出');
    expect(r.toast).toBeNull();
  });
});

describe('buildOutcomeMessage —— 调色成片', () => {
  it('全部成功：单位是「张」，动词是「已生成」', () => {
    const r = buildOutcomeMessage({
      mode: 'render',
      outcome: outcome({ exported: 12 }),
      targetFolder: 'D:/out',
    });
    expect(r.failed).toBe(false);
    expect(r.message).toBe('成片生成完成：已生成 12 张。（目标：D:/out）');
    // 成功不弹 Toast（与复制模式同一条规则）
    expect(r.toast).toBeNull();
  });

  it('部分失败：标题必须否定「完全成功」', () => {
    const r = buildOutcomeMessage({
      mode: 'render',
      outcome: outcome({
        exported: 11,
        skipped: 2,
        failed: [{ path: 'D:/shoot/IMG_2.CR2', reason: '渲染超时' }],
      }),
      targetFolder: 'D:/out',
    });
    expect(r.failed).toBe(true);
    expect(r.message).toContain('成片生成未完全成功：失败 1 张 · 已生成 11 张');
    expect(r.message).toContain('跳过 2 张（目标已存在同名成片）');
    expect(r.toast).toEqual({
      kind: 'error',
      text: '成片生成未完全成功：失败 1 张，成功 11 张',
    });
  });

  it('取消：宾语是「任何成片」', () => {
    const r = buildOutcomeMessage({
      mode: 'render',
      outcome: outcome({ cancelled: true }),
      targetFolder: 'D:/out',
    });
    expect(r.message).toBe('已取消导出：目标目录未产生任何成片。（目标：D:/out）');
    expect(r.toast).toBeNull();
  });

  it('两种模式句式同构：只换名词与动词', () => {
    const copy = buildOutcomeMessage({
      mode: 'copy',
      outcome: outcome({ exported: 4 }),
      targetFolder: 'X',
    });
    const render = buildOutcomeMessage({
      mode: 'render',
      outcome: outcome({ exported: 4 }),
      targetFolder: 'X',
    });
    // 比结构而不是字符偏移：`{标题}：{动词} N {单位}。（目标：X）`
    const shape = /^[^：]+：已(导出|生成) 4 (个|张)。（目标：X）$/;
    expect(copy.message).toMatch(shape);
    expect(render.message).toMatch(shape);
  });
});

describe('buildValidationMessage', () => {
  const base = {
    mode: 'copy' as const,
    targetFolder: 'D:/out',
    targetIsSourceDir: false,
    candidateCount: 3,
    includeRaw: true,
    includeJpg: true,
    lumenAvailable: true,
  };

  it('可执行时返回 null', () => {
    expect(buildValidationMessage(base)).toBeNull();
  });

  it('空目标优先于其他问题', () => {
    expect(
      buildValidationMessage({ ...base, targetFolder: '   ', candidateCount: 0 }),
    ).toBe('请先选择导出目标文件夹。');
  });

  it('目标 = 源目录', () => {
    expect(buildValidationMessage({ ...base, targetIsSourceDir: true })).toContain(
      '不能是源照片所在目录',
    );
  });

  it('无候选', () => {
    expect(buildValidationMessage({ ...base, candidateCount: 0 })).toContain(
      '没有照片',
    );
  });

  it('复制模式：类型全不选被拦', () => {
    expect(
      buildValidationMessage({ ...base, includeRaw: false, includeJpg: false }),
    ).toContain('至少勾选一种');
  });

  it('成片模式：类型勾选与结果无关，不继承复制的校验', () => {
    expect(
      buildValidationMessage({
        ...base,
        mode: 'render',
        includeRaw: false,
        includeJpg: false,
      }),
    ).toBeNull();
  });

  it('成片模式：引擎不可用时给出 detail', () => {
    const msg = buildValidationMessage({
      ...base,
      mode: 'render',
      lumenAvailable: false,
      lumenDetail: '未找到 lumen-cli.exe',
    });
    expect(msg).toBe('LUMEN RAW 引擎不可用：未找到 lumen-cli.exe');
  });

  it('成片模式：detail 缺失或空白时用兜底句', () => {
    expect(
      buildValidationMessage({
        ...base,
        mode: 'render',
        lumenAvailable: false,
        lumenDetail: '   ',
      }),
    ).toBe('LUMEN RAW 引擎不可用：未检测到可用的 lumen-cli');
  });

  it('复制模式：引擎不可用不影响', () => {
    expect(buildValidationMessage({ ...base, lumenAvailable: false })).toBeNull();
  });
});

describe('clampQuality', () => {
  it('越界夹取到 50–100', () => {
    expect(clampQuality(200)).toBe(100);
    expect(clampQuality(10)).toBe(50);
  });

  it('NaN / 非有限值回落到默认值', () => {
    expect(clampQuality(Number.NaN)).toBe(DEFAULT_RENDER_QUALITY);
    expect(clampQuality(Number.POSITIVE_INFINITY)).toBe(DEFAULT_RENDER_QUALITY);
  });

  it('合法值四舍五入', () => {
    expect(clampQuality(92.6)).toBe(93);
  });
});

describe('buildJpegSourceWarning —— 二次压缩提示（提示而非禁用）', () => {
  it('没有仅含 JPG 的候选时返回 null', () => {
    expect(buildJpegSourceWarning(0)).toBeNull();
  });

  it('负数（调用方算错）也返回 null，不产生「-1 组」这种句子', () => {
    expect(buildJpegSourceWarning(-1)).toBeNull();
  });

  it('命中时给出组数、损失说明与两条替代方案', () => {
    const text = buildJpegSourceWarning(3);
    expect(text).toContain('3 组仅含 JPG');
    expect(text).toContain('二次压缩');
    // 两条可执行的替代路径都要给出，只说「有损失」等于把问题丢回给用户
    expect(text).toContain('TIFF');
    expect(text).toContain('100');
  });

  it('组数原样透传（不四舍五入、不省略）', () => {
    expect(buildJpegSourceWarning(12)).toContain('12 组');
    expect(buildJpegSourceWarning(1)).toContain('1 组');
  });
});
