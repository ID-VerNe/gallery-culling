/**
 * 出厂镜头预设前后端一致门禁的单测（issue #125）。
 *
 * 重点是造数据把每条判定分支打红：解析、字段漂移、顺序漂移、条数漂移、
 * 定义消失、解析失败不判绿。以及拿仓库现状跑一遍必须绿（门禁已落地后）。
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkLensParity,
  findRustLensPresetsPaths,
  judgeLensParity,
  parseRustLensPresets,
  parseTsLensPresets,
} from './check-lens-parity.mjs';

const TS_OK = `export const BUILTIN_LENS_PRESETS = [
  { name: 'Voigtlander APO-LANTHAR 50mm F2', focal: '50mm', aperture: 'f/2.0' },
  { name: 'Voigtlander NOKTON 35mm F1.2', focal: '35mm', aperture: 'f/1.2' },
  { name: 'TTArtisan 28mm F5.6', focal: '28mm', aperture: 'f/5.6' },
];
`;

const RUST_OK = `pub fn builtin_lens_presets() -> Vec<LensPreset> {
    vec![
        LensPreset {
            name: "Voigtlander APO-LANTHAR 50mm F2".to_string(),
            focal: "50mm".to_string(),
            aperture: "f/2.0".to_string(),
        },
        LensPreset {
            name: "Voigtlander NOKTON 35mm F1.2".to_string(),
            focal: "35mm".to_string(),
            aperture: "f/1.2".to_string(),
        },
        LensPreset {
            name: "TTArtisan 28mm F5.6".to_string(),
            focal: "28mm".to_string(),
            aperture: "f/5.6".to_string(),
        },
    ]
}
`;

describe('parseTsLensPresets', () => {
  it('解析出三条的三元组', () => {
    const { presets, problems } = parseTsLensPresets(TS_OK);
    expect(problems).toEqual([]);
    expect(presets).toHaveLength(3);
    expect(presets[1]).toEqual({
      name: 'Voigtlander NOKTON 35mm F1.2',
      focal: '35mm',
      aperture: 'f/1.2',
    });
  });

  it('双引号也认', () => {
    const src = `export const BUILTIN_LENS_PRESETS = [
  { name: "A", focal: "50mm", aperture: "f/2.0" },
];
`;
    const { presets, problems } = parseTsLensPresets(src);
    expect(problems).toEqual([]);
    expect(presets).toEqual([{ name: 'A', focal: '50mm', aperture: 'f/2.0' }]);
  });

  it('找不到定义时收进 problems，而不是抛出去', () => {
    const { presets, problems } = parseTsLensPresets('export const OTHER = [];\n');
    expect(presets).toEqual([]);
    expect(problems.some((p) => p.includes('BUILTIN_LENS_PRESETS'))).toBe(true);
  });

  it('数组里没有条目时判红', () => {
    const { presets, problems } = parseTsLensPresets(
      'export const BUILTIN_LENS_PRESETS = [];\n',
    );
    expect(presets).toEqual([]);
    expect(problems).toHaveLength(1);
  });
});

describe('parseRustLensPresets', () => {
  it('解析出三条的三元组', () => {
    const { presets, problems } = parseRustLensPresets(RUST_OK);
    expect(problems).toEqual([]);
    expect(presets).toHaveLength(3);
    expect(presets[2]).toEqual({
      name: 'TTArtisan 28mm F5.6',
      focal: '28mm',
      aperture: 'f/5.6',
    });
  });

  it('找不到函数时收进 problems', () => {
    const { presets, problems } = parseRustLensPresets('fn main() {}\n');
    expect(presets).toEqual([]);
    expect(problems.some((p) => p.includes('builtin_lens_presets'))).toBe(true);
  });

  it('函数里没有条目时判红', () => {
    const { presets, problems } = parseRustLensPresets(
      'pub fn builtin_lens_presets() -> Vec<LensPreset> {\n    vec![]\n}\n',
    );
    expect(presets).toEqual([]);
    expect(problems).toHaveLength(1);
  });
});

describe('judgeLensParity —— 两处比对', () => {
  const base = () => ({
    ts: parseTsLensPresets(TS_OK),
    rust: parseRustLensPresets(RUST_OK),
  });

  it('两处一致 → 绿', () => {
    expect(judgeLensParity(base()).ok).toBe(true);
  });

  it('后端第 2 条改名而前端未同步 → 红，且点名第 2 条 name', () => {
    const drifted = base();
    drifted.rust = parseRustLensPresets(
      RUST_OK.replace('Voigtlander NOKTON 35mm F1.2', 'Voigtlander NOKTON 35mm F1.4'),
    );
    const verdict = judgeLensParity(drifted);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('第 2 条 name 不一致');
    expect(verdict.message).toContain('Voigtlander NOKTON 35mm F1.4');
  });

  it('前端改焦段 → 红，且点名 focal', () => {
    const drifted = base();
    drifted.ts = parseTsLensPresets(TS_OK.replace("focal: '35mm'", "focal: '50mm'"));
    const verdict = judgeLensParity(drifted);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('focal');
  });

  it('调顺序 → 红（同序也是契约）', () => {
    const swapped = `export const BUILTIN_LENS_PRESETS = [
  { name: 'Voigtlander NOKTON 35mm F1.2', focal: '35mm', aperture: 'f/1.2' },
  { name: 'Voigtlander APO-LANTHAR 50mm F2', focal: '50mm', aperture: 'f/2.0' },
  { name: 'TTArtisan 28mm F5.6', focal: '28mm', aperture: 'f/5.6' },
];
`;
    const drifted = { ts: parseTsLensPresets(swapped), rust: parseRustLensPresets(RUST_OK) };
    const verdict = judgeLensParity(drifted);
    expect(verdict.ok).toBe(false);
  });

  it('删一条 → 红（条数与独有条目都点名）', () => {
    const shorter = `export const BUILTIN_LENS_PRESETS = [
  { name: 'Voigtlander APO-LANTHAR 50mm F2', focal: '50mm', aperture: 'f/2.0' },
  { name: 'Voigtlander NOKTON 35mm F1.2', focal: '35mm', aperture: 'f/1.2' },
];
`;
    const drifted = { ts: parseTsLensPresets(shorter), rust: parseRustLensPresets(RUST_OK) };
    const verdict = judgeLensParity(drifted);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('条数不一致');
    expect(verdict.message).toContain('Rust 独有');
  });

  it('多一条 → 红，并点名 TS 独有', () => {
    const longer = `${TS_OK.replace('\n];', `
  { name: 'Extra 50mm', focal: '50mm', aperture: 'f/2.0' },
];`)}`;
    const drifted = { ts: parseTsLensPresets(longer), rust: parseRustLensPresets(RUST_OK) };
    const verdict = judgeLensParity(drifted);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('TS 独有');
  });

  it('解析失败时不拿半份数据判绿', () => {
    const verdict = judgeLensParity({
      ts: parseTsLensPresets('export const OTHER = [];\n'),
      rust: parseRustLensPresets(RUST_OK),
    });
    expect(verdict.ok).toBe(false);
  });
});

describe('仓库现状（真文件比对）', () => {
  it('TS / Rust 两处一致', () => {
    const verdict = checkLensParity();
    expect(verdict.ok, verdict.message).toBe(true);
  });
});

describe('findRustLensPresetsPaths —— issue #145 拆分后不再硬编码 models.rs', () => {
  const list = () => ['photo.rs', 'settings.rs', 'lumen.rs'];
  const readSplitLayout = (path) => {
    if (path.endsWith('models.rs')) return '//! façade\npub use settings::*;\n';
    if (path.endsWith('settings.rs'))
      return 'pub fn builtin_lens_presets() -> Vec<LensPreset> { vec![] }\n';
    if (path.endsWith('photo.rs')) return 'pub struct PhotoFileInfo {}\n';
    throw new Error('unexpected ' + path);
  };

  it('定义只在 models/settings.rs 时也能定位到（façade 只 re-export）', () => {
    const found = findRustLensPresetsPaths({ root: '/x', read: readSplitLayout, list });
    expect(found).toHaveLength(1);
    expect(found[0].endsWith(join('models', 'settings.rs'))).toBe(true);
  });

  it('façade 与域文件同时定义 → 命中 2 处，交由调用方判红', () => {
    const readBoth = (path) =>
      path.endsWith('models.rs') || path.endsWith('settings.rs')
        ? 'pub fn builtin_lens_presets() {}\n'
        : 'pub struct X {}\n';
    expect(findRustLensPresetsPaths({ root: '/x', read: readBoth, list })).toHaveLength(2);
  });

  it('任何文件都没有定义 → 空数组，交由调用方判红', () => {
    expect(
      findRustLensPresetsPaths({ root: '/x', read: () => 'fn main() {}\n', list }),
    ).toEqual([]);
  });

  it('checkLensParity 层：Rust 侧 0 命中判红，不拿半份数据判绿', () => {
    const verdict = checkLensParity({
      root: '/x',
      read: (path) => (path.endsWith('lensPresets.ts') ? TS_OK : 'fn main() {}\n'),
      list: () => ['photo.rs'],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('命中 0 处');
  });
});
