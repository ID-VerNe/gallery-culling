/**
 * 导出名三处一致门禁的单测（issue #124）。
 *
 * 重点是造数据把每条判定分支打红：解析、TS 比对、e2e 漂移、整类消失。
 * 以及拿仓库现状跑一遍必须绿（门禁已落地后）。
 */
import { describe, expect, it } from 'vitest';
import {
  checkExportNames,
  extractE2eNames,
  judgeExportNames,
  parseRustConstants,
  parseTsManifest,
} from './check-export-names.mjs';

const RUST_OK = [
  'pub const EXPORT_MANIFEST_NAME: &str = ".gallery-export.json";',
  'pub const EXPORT_TMP_PREFIX: &str = ".gallery-export-tmp-";',
].join('\n');
const TS_OK = "export const EXPORT_MANIFEST_NAME = '.gallery-export.json';";

const E2E_OK = [
  "files.some((f) => f.includes('.gallery-export-tmp-'))",
  "files.includes('.gallery-export.json')",
  "path.join(OUT, '.gallery-export.json')",
].join('\n');

describe('parseRustConstants', () => {
  it('解析清单名与 tmp 前缀', () => {
    const { manifest, tmpPrefix, problems } = parseRustConstants(RUST_OK);
    expect(problems).toEqual([]);
    expect(manifest).toBe('.gallery-export.json');
    expect(tmpPrefix).toBe('.gallery-export-tmp-');
  });

  it('找不到常量时收进 problems，而不是抛出去', () => {
    const { manifest, problems } = parseRustConstants('fn main() {}\n');
    expect(manifest).toBeNull();
    expect(problems.some((p) => p.includes('EXPORT_MANIFEST_NAME'))).toBe(true);
    expect(problems.some((p) => p.includes('EXPORT_TMP_PREFIX'))).toBe(true);
  });

  it('只改常量值仍能解析（判定层负责比对，不在这里猜）', () => {
    const drifted = RUST_OK.replace('.gallery-export.json', '.gallery-export-DRIFT.json');
    const { manifest, problems } = parseRustConstants(drifted);
    expect(problems).toEqual([]);
    expect(manifest).toBe('.gallery-export-DRIFT.json');
  });
});

describe('parseTsManifest', () => {
  it('单引号与双引号都认', () => {
    expect(parseTsManifest(TS_OK).value).toBe('.gallery-export.json');
    expect(parseTsManifest('export const EXPORT_MANIFEST_NAME = ".gallery-export.json";').value).toBe(
      '.gallery-export.json',
    );
  });

  it('找不到常量时判红并点名文件', () => {
    const { value, problems } = parseTsManifest('export const OTHER = 1;\n');
    expect(value).toBeNull();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('exportMessages.ts');
  });
});

describe('extractE2eNames', () => {
  it('描述句里的子串也算引用（按子串不挑整串）', () => {
    const names = extractE2eNames("'写入 .gallery-export.json manifest'");
    expect(names).toEqual(['.gallery-export.json']);
  });

  it('整串引用与漂移值都被抽出', () => {
    const names = extractE2eNames(
      "includes('.gallery-export.json')\nincludes('.gallery-export-tmp-DRIFT-')",
    );
    expect(names).toContain('.gallery-export.json');
    expect(names).toContain('.gallery-export-tmp-DRIFT-');
  });

  it('不把无 gallery-export 的字符串算进来', () => {
    expect(extractE2eNames("'写入成功'\nfiles.join(',')")).toEqual([]);
  });
});

describe('judgeExportNames —— 三处比对', () => {
  const base = () => ({
    rust: parseRustConstants(RUST_OK),
    ts: parseTsManifest(TS_OK),
    e2e: [{ file: 'e2e/run-inapp.mjs', names: extractE2eNames(E2E_OK) }],
  });

  it('三处一致 → 绿', () => {
    expect(judgeExportNames(base()).ok).toBe(true);
  });

  it('TS 漂移 → 红，且点名 TS', () => {
    const drifted = base();
    drifted.ts = parseTsManifest("export const EXPORT_MANIFEST_NAME = '.gallery-export-DRIFT.json';");
    const verdict = judgeExportNames(drifted);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('TS 的 EXPORT_MANIFEST_NAME');
    expect(verdict.message).toContain('.gallery-export-DRIFT.json');
  });

  it('e2e 单处 tmp 漂移 → 红，且点名文件与值', () => {
    const drifted = base();
    drifted.e2e = [
      { file: 'e2e/run-inapp.mjs', names: ['.gallery-export.json', '.gallery-export-tmp-DRIFT-'] },
    ];
    const verdict = judgeExportNames(drifted);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('e2e/run-inapp.mjs');
    expect(verdict.message).toContain('.gallery-export-tmp-DRIFT-');
  });

  it('Rust 改名而他处未同步 → 红', () => {
    const drifted = base();
    drifted.rust = parseRustConstants(
      RUST_OK.replace('.gallery-export.json', '.gallery-export-NEW.json'),
    );
    const verdict = judgeExportNames(drifted);
    expect(verdict.ok).toBe(false);
  });

  it('e2e 里 tmp 被删光 → 红（残留检查被删了）', () => {
    const drifted = base();
    drifted.e2e = [{ file: 'e2e/run-inapp.mjs', names: extractE2eNames("files.includes('.gallery-export.json')") }];
    const verdict = judgeExportNames(drifted);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('tmp 前缀');
  });

  it('e2e 里完全没有引用 → 红', () => {
    const drifted = base();
    drifted.e2e = [];
    const verdict = judgeExportNames(drifted);
    expect(verdict.ok).toBe(false);
  });

  it('Rust 解析失败时不拿半份数据判绿', () => {
    const verdict = judgeExportNames({
      rust: parseRustConstants('fn main() {}'),
      ts: parseTsManifest(TS_OK),
      e2e: [{ file: 'e2e/run-inapp.mjs', names: ['.gallery-export.json', '.gallery-export-tmp-'] }],
    });
    expect(verdict.ok).toBe(false);
  });
});

describe('仓库现状（真文件比对）', () => {
  it('Rust / TS / e2e 三处一致', () => {
    const verdict = checkExportNames();
    expect(verdict.ok, verdict.message).toBe(true);
  });
});
