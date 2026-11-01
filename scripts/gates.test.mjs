/**
 * 门禁自身的单测（issue #6）。
 *
 * 为什么值得测：元门禁坏了是**静默放行**——它不红，就没有任何东西会提醒你
 * 「清单已经和磁盘对不上了」。所以每条规则都要能单独造数据打红。
 *
 * 最后一组直接拿仓库现状跑一遍：门禁清单漂移应该在本机就被发现，而不是等 CI。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  diffManifest,
  extractAgentsSection,
  parseShardMatrix,
  renderAgentsSection,
  ROOT,
} from './check-gates-manifest.mjs';
import { countFmtDiffs, judgeFmt } from './check-fmt-baseline.mjs';
import { loadManifest, shardNames, shardRows } from './run-gates.mjs';

const manifest = loadManifest();
const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
const ciYml = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const diskScripts = readdirSync(join(ROOT, 'scripts')).filter((name) =>
  /^check-[a-z0-9-]+\.mjs$/.test(name),
);

const clean = (overrides = {}) =>
  diffManifest({
    diskCheckScripts: diskScripts,
    manifest,
    agentsSection: extractAgentsSection(agents),
    ciShards: parseShardMatrix(ciYml),
    ...overrides,
  });

describe('parseShardMatrix', () => {
  it('取出 matrix 里的分片', () => {
    expect(parseShardMatrix('matrix:\n  shard: [static, unit, rust]\n')).toEqual([
      'static',
      'unit',
      'rust',
    ]);
  });

  it('容忍引号与空格', () => {
    expect(parseShardMatrix(`shard: [ 'static' ,  "unit" ]`)).toEqual(['static', 'unit']);
  });

  it('没有分片矩阵时返回 null（不是空数组）', () => {
    expect(parseShardMatrix('jobs:\n  gates:\n    steps: []\n')).toBeNull();
  });
});

describe('生成段渲染与提取', () => {
  it('渲染结果能被 extractAgentsSection 原样取回', () => {
    const section = renderAgentsSection(manifest);
    expect(extractAgentsSection(`前言\n${section}\n后记`)).toBe(section);
  });

  it('缺标记时返回 null', () => {
    expect(extractAgentsSection('没有标记的文档')).toBeNull();
  });
});

describe('diffManifest —— 四种漂移各自打红', () => {
  it('仓库现状一致', () => {
    expect(clean()).toEqual([]);
  });

  it('磁盘有脚本但清单没登记', () => {
    const problems = clean({ diskCheckScripts: [...diskScripts, 'check-ghost.mjs'] });
    expect(problems.join('\n')).toContain('check-ghost.mjs');
    expect(problems.join('\n')).toContain('没登记');
  });

  it('清单登记了但磁盘没有', () => {
    const problems = clean({ diskCheckScripts: diskScripts.filter((n) => n !== 'check-fmt-baseline.mjs') });
    expect(problems.join('\n')).toContain('磁盘上没有这个脚本');
  });

  it('同一条门禁登记在两个档位', () => {
    const doubled = structuredClone(manifest);
    doubled.support.push({ name: 'check-fmt-baseline.mjs', why: '重复登记' });
    const problems = clean({ manifest: doubled });
    expect(problems.join('\n')).toContain('多个档位');
  });

  it('AGENTS.md 生成段与清单不一致', () => {
    const problems = clean({ agentsSection: '<!-- gates:ci:begin -->\n旧表\n<!-- gates:ci:end -->' });
    expect(problems.join('\n')).toContain('生成段与 gates.json 不一致');
  });

  it('生成段的 CRLF 与 LF 等价（新克隆检出是 CRLF，不能因此假红）', () => {
    const section = renderAgentsSection(manifest).replace(/\n/g, '\r\n');
    expect(clean({ agentsSection: section })).toEqual([]);
  });

  it('ci.yml 分片与清单不一致', () => {
    const problems = clean({ ciShards: ['static', 'unit'] });
    expect(problems.join('\n')).toContain('不一致');
  });

  it('ci.yml 没有分片矩阵', () => {
    const problems = clean({ ciShards: null });
    expect(problems.join('\n')).toContain('shard: [...]');
  });
});

describe('fmt 基线', () => {
  it('只数行首的 Diff in', () => {
    const output = [
      'Diff in C:\\x\\db.rs at line 12:',
      '  let a = 1;',
      'Diff in C:\\x\\lib.rs:30:',
      'const NOTE: &str = "Diff in the middle is not a header";',
    ].join('\n');
    expect(countFmtDiffs(output)).toBe(2);
  });

  it('超过基线判红，且提示撤回重排', () => {
    const verdict = judgeFmt(130, 122);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('cargo fmt');
  });

  it('等于基线判绿', () => {
    expect(judgeFmt(122, 122).ok).toBe(true);
  });

  it('低于基线判绿但提醒下调', () => {
    const verdict = judgeFmt(120, 122);
    expect(verdict.ok).toBe(true);
    expect(verdict.message).toContain('下调');
  });
});

describe('run-gates 清单读取', () => {
  it('分片顺序与清单一致', () => {
    expect(shardNames(manifest)).toEqual(['static', 'unit', 'rust']);
  });

  it('按分片取门禁，每条都有 cmd 与 why', () => {
    for (const shard of shardNames(manifest)) {
      const rows = shardRows(manifest, shard);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(Array.isArray(row.cmd)).toBe(true);
        expect(row.why.length).toBeGreaterThan(0);
      }
    }
  });

  it('分片外的门禁不存在', () => {
    expect(shardRows(manifest, 'nope')).toEqual([]);
  });
});
