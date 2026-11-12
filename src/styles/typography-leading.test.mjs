/**
 * 小字行高口径的结构契约（issue #39 · PC-8，源自 issue #18 审计）。
 *
 * jsdom 钉不了「10px 配 1.625 行高读起来发不散」——那属真机目视，进
 * needs-live-verify。这里钉的是**源码口径**：小字（≤11px）的行高跟字号走，
 * 绝对行高统一到 ≈15px：
 *   - 10px → `leading-[1.5]`（15.0px）
 *   - 11px → `leading-snug`（1.375 → 15.125px）
 *   - 12px+ 正文层保持 `leading-relaxed`；单行截断标签可 `leading-tight` 或省略
 *
 * 为什么按字号而不按用途：同一字号在这 9 个面板里既出现在多行说明
 * （SettingsSections:50）也出现在密集列表（ShortcutHelpModal:99），按用途定会
 * 产出「同字号两种行高」，反而分叉口径。绝对行高 15px 也不是新造一套——
 * ThumbnailGrid:365 的查询状态行早已是 `text-[10px] leading-[15px]`。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'src');

/** 本单逐处核过的 9 个面板文件（issue #39 改动范围，issue #114 拆出 LensPresetPanel）。 */
const PANEL_FILES = [
  'src/components/SettingsSections.tsx',
  'src/components/TonalAdjuster.tsx',
  'src/components/MetadataEditorModal.tsx',
  'src/components/LensPresetPanel.tsx',
  'src/components/export/RenderOptions.tsx',
  'src/components/export/WatermarkOptions.tsx',
  'src/components/Modal.tsx',
  'src/components/ShortcutHelpModal.tsx',
  'src/components/ThumbnailGrid.tsx',
];

/** 10px 允许的行高：目标值 1.5（或等价的 15px），单行截断标签保留 tight。 */
const LEADING_10PX_ALLOWED = ['leading-[1.5]', 'leading-[15px]', 'leading-tight'];

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(abs));
    else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.')) {
      files.push(abs);
    }
  }
  return files;
}

/** 取出所有 className 属性值（含模板串），带上 1 起的行号，便于失败时报位置。 */
function classNameEntries(source) {
  const re = /className=(?:"([^"]*)"|\{`([^`]*)`\}|'([^']*)')/g;
  const entries = [];
  let match;
  while ((match = re.exec(source)) !== null) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    entries.push({ value, line: source.slice(0, match.index).split('\n').length });
  }
  return entries;
}

function scan(relPaths) {
  return relPaths.map((rel) => ({
    rel,
    entries: classNameEntries(readFileSync(join(ROOT, rel), 'utf8')),
  }));
}

function allSourceFiles() {
  return walk(SRC).map((abs) => relative(ROOT, abs).replace(/\\/g, '/'));
}

/** 同一条 className 串里同时出现某字号与 `leading-relaxed` 的违规位。 */
function relaxedViolations(relPaths, sizeToken) {
  return scan(relPaths)
    .flatMap(({ rel, entries }) =>
      entries
        .filter((e) => e.value.includes(sizeToken) && e.value.includes('leading-relaxed'))
        .map((e) => `${rel}:${e.line} ${sizeToken} + leading-relaxed`),
    );
}

/** 小字若带 leading-*，只能落在允许集合里（省略 leading 不判违规）。 */
function leadingViolations(relPaths, sizeToken, allowed) {
  return scan(relPaths)
    .flatMap(({ rel, entries }) =>
      entries
        .filter((e) => e.value.includes(sizeToken) && /leading-/.test(e.value))
        .map((e) => {
          const tokens = e.value.match(/leading-[^\s'"`]*/g) ?? [];
          return tokens
            .filter((t) => !allowed.includes(t))
            .map((t) => `${rel}:${e.line} ${sizeToken} + ${t}`);
        })
        .flat(),
    );
}

function countPairs(relPaths, sizeToken, leadingToken) {
  return scan(relPaths).reduce(
    (sum, { entries }) =>
      sum +
      entries.filter((e) => e.value.includes(sizeToken) && e.value.includes(leadingToken)).length,
    0,
  );
}

describe('小字行高口径（issue #39 · PC-8）', () => {
  it('全仓非测试 .tsx/.ts：没有任何 10px 与 leading-relaxed 同串（新写一处即红）', () => {
    expect(relaxedViolations(allSourceFiles(), 'text-[10px]')).toEqual([]);
  });

  it('全仓非测试 .tsx/.ts：没有任何 11px 与 leading-relaxed 同串（新写一处即红）', () => {
    expect(relaxedViolations(allSourceFiles(), 'text-[11px]')).toEqual([]);
  });

  it('9 个面板文件：10px 只配 leading-[1.5] / leading-[15px] / leading-tight 或省略', () => {
    expect(
      leadingViolations(PANEL_FILES, 'text-[10px]', LEADING_10PX_ALLOWED),
    ).toEqual([]);
  });

  it('9 个面板文件：11px 只配 leading-snug 或省略（不许 relaxed / tight / none）', () => {
    expect(leadingViolations(PANEL_FILES, 'text-[11px]', ['leading-snug'])).toEqual([]);
  });

  // issue #192：SettingsSections 的「宫格缩略图也用 LUMEN RAW 渲染」说明段随开关
  // 一起下线，台账从 26 降到 25。这是**净减少一处合法用法**，不是放宽口径 ——
  // 阈值仍按「现存每一处都必须在」卡住，任何批量回退（例如把 leading 改回
  // relaxed）都会让计数继续下降并变红。
  it('迁移台账：9 个面板文件里 10px + leading-[1.5] 不少于 25 处（防批量回退）', () => {
    expect(countPairs(PANEL_FILES, 'text-[10px]', 'leading-[1.5]')).toBeGreaterThanOrEqual(25);
  });

  it('迁移台账：9 个面板文件里 11px + leading-snug 不少于 10 处（防批量回退）', () => {
    expect(countPairs(PANEL_FILES, 'text-[11px]', 'leading-snug')).toBeGreaterThanOrEqual(10);
  });
});
