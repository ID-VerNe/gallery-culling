/**
 * 门禁自身的单测（issue #6 / #8）。
 *
 * 为什么值得测：元门禁坏了是**静默放行**——它不红，就没有任何东西会提醒你
 * 「清单已经和磁盘对不上了」。所以每条规则都要能单独造数据打红。
 *
 * 最后一组直接拿仓库现状跑一遍：门禁清单漂移应该在本机就被发现，而不是等 CI。
 */
import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  diffManifest,
  extractAgentsSection,
  parseShardMatrix,
  renderAgentsSection,
  ROOT,
} from './check-gates-manifest.mjs';
import { countFmtDiffs, judgeFmt } from './check-fmt-baseline.mjs';
import { loadManifest, missingTools, runOne, shardNames, shardRows, toolFiles } from './run-gates.mjs';
import {
  APPROVED_AT,
  changedFiles,
  gateApplies,
  gateChain,
  gateSection,
  globToRegExp,
  judge,
  main,
  parseTime,
  reviewOrderProblem,
  reviewRecord,
} from './check-gate-change-review.mjs';
import {
  linkModules,
  missingInputs,
  resolveRef,
  shardProblem,
  unlinkModules,
} from './check-pr-parity.mjs';

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

  it('门禁命令行不经 npx / npm exec', () => {
    // issue #24：`npx tsc --noEmit` 在 `node_modules/.bin` 缺席时会去 registry
    // 装一个**同名但无关**的包（`tsc@2.0.4`），它打印「This is not the tsc
    // command you are looking for」后 **exit 0** —— 类型检查一行没跑，门禁却报绿。
    // npx 会把调用方的解析结果当成可协商项，门禁的输入必须是本地 pin 死的。
    //
    // 光看 argv[0] 不够：`node ./node_modules/.bin/tsc` 既不是 npx 也不是 npm，
    // 却复用了同一条「本机 bin 垫片」的解析规则。垫片缺席时 node 把这个无扩展名的
    // 路径当 CJS 跑，还是那句「这不是你要的 tsc」，还是 exit 0。门禁只许直指
    // 包内入口，所以这里连路径也一起钉。
    for (const row of manifest.ci) {
      expect(row.cmd[0], `${row.name} 的命令行不该经 npx`).not.toBe('npx');
      expect(row.cmd[0], `${row.name} 的命令行不该经 npm exec`).not.toBe('npm');
      if (row.cmd[0] === 'node' && row.cmd[1]?.startsWith('node_modules/')) {
        expect(row.cmd[1], `${row.name} 该直指包内入口，不该走 .bin 垫片`).not.toMatch(
          /^node_modules[/\\]\.bin[/\\]/,
        );
      }
    }
  });
});

describe('run-gates 启动前检查工具文件', () => {
  it('从 node 命令行里认出本地工具文件', () => {
    expect(toolFiles(['node', 'node_modules/typescript/bin/tsc', '--noEmit'])).toEqual([
      { command: 'node', file: 'node_modules/typescript/bin/tsc' },
    ]);
    expect(toolFiles(['node', 'node_modules/vitest/vitest.mjs', 'run'])).toEqual([
      { command: 'node', file: 'node_modules/vitest/vitest.mjs' },
    ]);
  });

  it('脚本与系统命令不算工具文件', () => {
    expect(toolFiles(['node', 'scripts/run-gates.mjs'])).toEqual([]);
    expect(toolFiles(['cargo', 'test', '--lib'])).toEqual([]);
    expect(toolFiles(['node', '-e', 'console.log(1)'])).toEqual([]);
    expect(toolFiles([])).toEqual([]);
  });

  it('工具文件缺席时判红并说明为什么不能靠命令自己报错', () => {
    const missing = missingTools(['node', 'node_modules/typescript/bin/tsc'], { exists: () => false });
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('node_modules/typescript/bin/tsc');
    expect(missing[0]).toContain('npm ci');
  });

  it('工具文件在盘上时不判红', () => {
    expect(missingTools(['node', 'node_modules/typescript/bin/tsc'], { exists: () => true })).toEqual([]);
  });

  it('工具缺席时**不启动子进程**，直接判红', () => {
    // 这条锁的是接线，不是 missingTools 的返回值：把 runOne 里那段预检查整块
    // 删掉，上面几个纯函数用例照样全绿，而缺依赖时会退回「拉起进程看它怎么崩」。
    const spawned = [];
    const spawn = (...args) => {
      spawned.push(args);
      return { status: 0 };
    };
    const status = runOne(
      { name: 'tsc --noEmit', cmd: ['node', 'node_modules/@scope/definitely-absent/bin/x'] },
      spawn,
    );
    expect(status).toBe(1);
    expect(spawned).toEqual([]);
  });

  it('工具齐全时照常启动，并把它自己的退出码原样交出去', () => {
    const spawned = [];
    const spawn = (command, args) => {
      spawned.push([command, args]);
      return { status: 7 };
    };
    const status = runOne(
      { name: 'tsc --noEmit', cmd: ['node', 'node_modules/typescript/bin/tsc', '--noEmit'] },
      spawn,
    );
    expect(status).toBe(7);
    expect(spawned).toEqual([['node', ['node_modules/typescript/bin/tsc', '--noEmit']]]);
  });
});

describe('scripts 下的 .mjs 不带 shebang', () => {
  // 2026-11-01 首次 CI 实证的坑：shebang + CRLF（autocrlf 检出）会让 vitest
  // 的模块管线吐 `SyntaxError: Invalid or unexpected token`，且不带任何栈——
  // node --check、esbuild、原生 import 都能过，唯独 vitest 不行。
  // 调用点全是显式 `node scripts/x.mjs`，shebang 没有存在价值；.gitattributes
  // 的 `*.mjs text eol=lf` 是第二道防线，这里锁第一道。
  it('每个 scripts/*.mjs 首行都不是 #!', () => {
    const files = readdirSync(join(ROOT, 'scripts')).filter((n) => n.endsWith('.mjs'));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const first = readFileSync(join(ROOT, 'scripts', name), 'utf8').split('\n', 1)[0];
      expect(first, `${name} 首行不应是 shebang`).not.toMatch(/^#!/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// issue #8：门禁链改动披露闸门
//
// 这条闸门坏了同样是**静默放行**：它不红，就没有任何东西会提醒你「有人在同一个 PR
// 里改软了断言」。所以每一档判定都成对造数据——坏形态必须红，同形的好形态必须绿。
// ─────────────────────────────────────────────────────────────────────────────

/** 一份合成的 PR 正文；`evidence` 与 `review` 分开传，方便造「自审形状」。 */
const gateBody = (evidence, review, extra = {}) =>
  [
    '## 问题',
    '',
    '随便什么问题。',
    '',
    '## 门禁改动',
    '',
    evidence,
    ...(review === null ? [] : ['', review]),
    ...(extra.afterReview ?? []),
    '',
    '## 测试',
    '',
    '- 下一段的内容不属于门禁改动段',
  ].join('\n');

const EVIDENCE = '- `scripts/check-gates-manifest.mjs`：断言从 2 条扩到 4 条，原因见 #8';

describe('globToRegExp', () => {
  it('`*` 跨目录（与 IdleJot 的 fnmatch 同口径）', () => {
    expect(globToRegExp('.githooks/*').test('.githooks/nested/deep/hook')).toBe(true);
  });

  it('`?` 只匹配一个字符', () => {
    expect(globToRegExp('a?.mjs').test('ab.mjs')).toBe(true);
    expect(globToRegExp('a?.mjs').test('abc.mjs')).toBe(false);
  });

  it('正则元字符被转义，不当通配用', () => {
    expect(globToRegExp('scripts/gates.json').test('scripts/gatesXjson')).toBe(false);
    expect(globToRegExp('scripts/gates.json').test('scripts/gates.json')).toBe(true);
  });
});

describe('gateChain —— 命中范围', () => {
  it('门禁链四类 + 钩子全命中', () => {
    expect(gateChain(['scripts/check-any.mjs', 'scripts/gates.json', 'scripts/run-gates.mjs'])).toEqual([
      'scripts/check-any.mjs',
      'scripts/gates.json',
      'scripts/run-gates.mjs',
    ]);
    expect(gateChain(['.github/workflows/ci.yml'])).toEqual(['.github/workflows/ci.yml']);
    expect(gateChain(['.githooks/pre-push', '.githooks/commit-msg'])).toEqual([
      '.githooks/pre-push',
      '.githooks/commit-msg',
    ]);
  });

  it('嵌套钩子路径也算（钩子是门禁执行入口）', () => {
    expect(gateChain(['.githooks/nested/deep/hook'])).toEqual(['.githooks/nested/deep/hook']);
  });

  it('非门禁文件不命中', () => {
    expect(gateChain(['README.md', 'src/App.tsx', 'doc/PR_GUIDE.md', 'scripts/release.mjs'])).toEqual([]);
  });

  it('保序去重，反斜杠路径归一', () => {
    expect(
      gateChain(['README.md', '.githooks/pre-push', 'scripts\\check-a.mjs', '.githooks/pre-push']),
    ).toEqual(['.githooks/pre-push', 'scripts/check-a.mjs']);
  });

  it('空数组进空数组出（parity / 本机直跑用得到）', () => {
    expect(gateChain([])).toEqual([]);
  });

  it('PATTERNS 覆盖仓库里每一条真实门禁脚本（新增门禁忘了登记会在这里红）', () => {
    const manifestNames = loadManifest()
      .ci.filter((row) => /^check-[a-z0-9-]+\.mjs$/.test(row.name))
      .map((row) => `scripts/${row.name}`);
    const scripts = readdirSync(join(ROOT, 'scripts'))
      .filter((name) => /^check-[a-z0-9-]+\.mjs$/.test(name))
      .map((name) => `scripts/${name}`);
    const expected = [...new Set([...manifestNames, ...scripts])];
    expect(expected.length).toBeGreaterThan(0);
    expect(gateChain(expected)).toEqual(expected);
  });
});

describe('gateSection —— 取段', () => {
  it('段到下一个同级标题为止', () => {
    const section = gateSection(gateBody(EVIDENCE, null));
    expect(section).toContain(EVIDENCE);
    expect(section).not.toContain('## 测试');
  });

  it('段内的 ### 子标题、引用块仍属本段', () => {
    const section = gateSection(gateBody(`${EVIDENCE}\n\n### 复核要点\n\n> 引用块`, null));
    expect(section).toContain('### 复核要点');
    expect(section).toContain('> 引用块');
  });

  it('没有该段返回 null（≠ 空串）', () => {
    expect(gateSection('## 问题\n\n没有门禁改动段\n')).toBeNull();
  });

  it('正文不可得返回 null', () => {
    expect(gateSection(null)).toBeNull();
  });
});

describe('reviewRecord / reviewOrderProblem', () => {
  const section = (review) => gateSection(gateBody(EVIDENCE, review));

  it('认出裸 APPROVE', () => {
    expect(reviewRecord(section('**独立复核**：APPROVE，证据见评论')).verdict).toBe('APPROVE');
  });

  it('APPROVED 优先于 APPROVE（长串先判）', () => {
    expect(reviewRecord(section('独立复核：APPROVED')).verdict).toBe('APPROVED');
  });

  it('REQUEST_CHANGES 也是合法结论', () => {
    expect(reviewRecord(section('独立复核：REQUEST_CHANGES，理由见评论')).verdict).toBe('REQUEST_CHANGES');
  });

  it('小写 approved 也认', () => {
    expect(reviewRecord(section('独立复核：approved')).verdict).toBe('APPROVED');
  });

  it('`<PENDING>` 不算结论', () => {
    expect(reviewRecord(section('独立复核：<PENDING>')).verdict).toBeNull();
  });

  it('没有复核行返回 (null, null)', () => {
    expect(reviewRecord(section(null))).toEqual({ line: null, verdict: null });
  });

  it('复核在段末合规；分隔线与纯 Refs 不算实质内容', () => {
    expect(reviewOrderProblem(section('独立复核：APPROVE'))).toBeNull();
    expect(reviewOrderProblem(section('独立复核：APPROVE\n\n---'))).toBeNull();
    expect(reviewOrderProblem(section('独立复核：APPROVE\n\nRefs #8'))).toBeNull();
  });

  it('复核之后还有证据行 → 报出该行（自审形状）', () => {
    expect(reviewOrderProblem(section('独立复核：APPROVE\n\n- 三种组合证据：见评论'))).toBe(
      '- 三种组合证据：见评论',
    );
  });
});

describe('gateApplies —— 时点边界', () => {
  it('基线晚于上界生效', () => {
    expect(gateApplies('2026-11-03T00:00:00Z')).toBe(true);
  });

  it('基线恰为上界生效', () => {
    expect(gateApplies(APPROVED_AT)).toBe(true);
  });

  it('基线早于上界不生效', () => {
    expect(gateApplies('2026-10-01T00:00:00Z')).toBe(false);
  });

  it('基线不可得 / 坏值不生效', () => {
    expect(gateApplies('')).toBe(false);
    expect(gateApplies(null)).toBe(false);
    expect(gateApplies('not-a-date')).toBe(false);
  });

  it('带时区偏移的 ISO 时间按绝对时刻比较（本仓提交时间是 +08:00）', () => {
    expect(parseTime('2026-11-02T08:00:00+08:00')).toBe(parseTime('2026-11-02T00:00:00Z'));
    expect(gateApplies('2026-11-02T08:00:00+08:00')).toBe(true);
    expect(gateApplies('2026-11-02T07:59:59+08:00')).toBe(false);
  });
});

describe('judge —— 披露闸门判定', () => {
  const touched = ['scripts/check-gates-manifest.mjs'];

  it('未触及门禁链 → 绿（有没有段都行）', () => {
    expect(judge([], '## 问题\n').code).toBe(0);
    expect(judge([], gateBody(EVIDENCE, null)).code).toBe(0);
  });

  it('触及但正文不可得 → 红，且点出要交代的文件', () => {
    const { code, lines } = judge(touched, null);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('scripts/check-gates-manifest.mjs');
    expect(lines.join('\n')).toContain('拿不到 PR 正文');
  });

  it('触及但正文没有该段 → 红', () => {
    const { code, lines } = judge(touched, '## 问题\n\n没有段\n');
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('没有');
  });

  it('触及且段内逐个交代 → 绿', () => {
    expect(judge(touched, gateBody(EVIDENCE, null)).code).toBe(0);
  });

  it('段内漏列某个文件 → 红，并点名漏列的那个', () => {
    const two = [...touched, '.githooks/pre-push'];
    const { code, lines } = judge(two, gateBody(EVIDENCE, null));
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('漏列：.githooks/pre-push');
  });

  it('路径只在段外提到不算交代', () => {
    // 段内证据刻意写「别的文件」：否则 EVIDENCE 本身就含目标路径，这条用例会假绿。
    const body = [
      '## 问题',
      '',
      '- 改了 `scripts/check-gates-manifest.mjs`',
      '',
      '## 门禁改动',
      '',
      '- 只交代了 `.githooks/pre-push` 的情况',
    ].join('\n');
    const { code, lines } = judge(touched, body);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('漏列：scripts/check-gates-manifest.mjs');
  });

  it('闸门生效前：缺复核行只提示不判红', () => {
    const { code, lines } = judge(touched, gateBody(EVIDENCE, null), false);
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('hint');
  });

  it('闸门生效：缺复核行 → 红', () => {
    const { code, lines } = judge(touched, gateBody(EVIDENCE, null), true);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('没有独立复核结论行');
  });

  it('闸门生效：PENDING → 红；同形 APPROVE 在段末 → 绿', () => {
    expect(judge(touched, gateBody(EVIDENCE, '独立复核：<PENDING>'), true).code).toBe(1);
    expect(judge(touched, gateBody(EVIDENCE, '独立复核：APPROVE'), true).code).toBe(0);
  });

  it('闸门生效：REQUEST_CHANGES 也是合法结论（结论已贴就放行，判定在评论里）', () => {
    expect(judge(touched, gateBody(EVIDENCE, '独立复核：REQUEST_CHANGES'), true).code).toBe(0);
  });

  it('闸门生效：自审形状（结论在前、证据在后）→ 红', () => {
    const body = gateBody('独立复核：APPROVE', '- `scripts/check-gates-manifest.mjs`：改了什么');
    const { code, lines } = judge(touched, body, true);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('复核结论排在正文证据之前');
  });

  it('闸门生效：段末的 Refs / 分隔线不打断「先证据后结论」', () => {
    const body = gateBody(EVIDENCE, '独立复核：APPROVE\n\nRefs #8\n\n---');
    expect(judge(touched, body, true).code).toBe(0);
  });

  it('闸门生效但未触及门禁链 → 仍绿（闸门只管门禁链改动）', () => {
    expect(judge([], gateBody(EVIDENCE, null), true).code).toBe(0);
  });
});

describe('changedFiles —— 改动集真的从 git 里读', () => {
  it('拿得到本仓任意一个 base...HEAD 的结果（空数组也是合法结果）', () => {
    // 不绑定具体提交：CI 的 checkout 深度、本地的分支形态都可能不同。
    // 这里只锁「调用成功且返回字符串数组」——失败会抛错，被 main 转成 fail-closed。
    const files = changedFiles('HEAD');
    expect(Array.isArray(files)).toBe(true);
    for (const file of files) expect(typeof file).toBe('string');
  });
});

describe('main —— 退出码契约（SKIP / fail-closed / 判定）', () => {
  // main 的每个分支都必须有能打红的用例：M5 变异（无 base 时不 fail-closed）曾在
  // 第一版测试网里存活，因为它只测了纯函数 judge，没测 main 的分支。
  const quiet = (code) => {
    const output = [];
    const log = console.log;
    const error = console.error;
    console.log = (line) => output.push(String(line));
    console.error = (line) => output.push(String(line));
    try {
      const rc = main(['node', 'scripts/check-gate-change-review.mjs', ...code.argv], code.env);
      return { rc, output: output.join('\n') };
    } finally {
      console.log = log;
      console.error = error;
    }
  };

  it('没有 base 也没声明 → SKIP 通过', () => {
    const { rc, output } = quiet({ argv: [], env: {} });
    expect(rc).toBe(0);
    expect(output).toContain('SKIP');
  });

  it('显式声明改动却没有 base → fail-closed（不许冒充 SKIP）', () => {
    const viaFlag = quiet({ argv: ['--gate-changes'], env: {} });
    expect(viaFlag.rc).toBe(1);
    expect(viaFlag.output).toContain('改动集不可得');
    const viaEnv = quiet({ argv: [], env: { GATE_CHANGES: '1' } });
    expect(viaEnv.rc).toBe(1);
  });

  it('非法 base → fail-closed（不能把 git 错误吞成绿）', () => {
    const { rc, output } = quiet({ argv: ['--base', 'definitely-not-a-ref-xyz'], env: {} });
    expect(rc).toBe(1);
    expect(output).toContain('无法计算');
  });

  it('正文文件读不到 → fail-closed', () => {
    const { rc } = quiet({
      argv: ['--base', 'HEAD', '--body-file', 'no-such-pr-body.md'],
      env: {},
    });
    expect(rc).toBe(1);
  });

  it('HEAD...HEAD 改动集为空 → 通过（端到端跑通 IO 那一段）', () => {
    const { rc, output } = quiet({ argv: ['--base', 'HEAD'], env: {} });
    expect(rc).toBe(0);
    expect(output).toContain('门禁链无改动');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// issue #8：CI 等价复跑（parity）
// ─────────────────────────────────────────────────────────────────────────────

describe('check-pr-parity', () => {
  it('合法分片返回 null，未知分片点名合法值', () => {
    expect(shardProblem(manifest, 'static')).toBeNull();
    expect(shardProblem(manifest, null)).toBeNull();
    expect(shardProblem(manifest, 'nope')).toContain('未知分片');
    expect(shardProblem(manifest, 'nope')).toContain('static、unit、rust');
  });

  it('清单没有分片时任何分片都不合法（fail-closed）', () => {
    expect(shardProblem({ shards: [] }, null)).toContain('没有任何分片');
    expect(shardProblem({}, 'static')).toContain('未知分片');
  });

  it('检出缺清单或执行器时点名缺的那个', () => {
    const exists = (path) => !path.includes('run-gates.mjs');
    expect(missingInputs('/tmp/x', { exists })).toEqual(['scripts/run-gates.mjs']);
    expect(missingInputs('/tmp/x', { exists: (path) => path.includes('run-gates.mjs') })).toEqual([
      'scripts/gates.json',
    ]);
    expect(missingInputs('/tmp/x', { exists: () => true })).toEqual([]);
  });

  it('ref 解析：HEAD 可用，垃圾 ref 返回 null（而不是抛错）', () => {
    expect(resolveRef('HEAD')).toMatch(/^[0-9a-f]{40}$/);
    expect(resolveRef('definitely-not-a-ref-xyz')).toBeNull();
  });

  // linkModules 是「干净检出里有没有依赖」的唯一判据。2026-11-02 实测：worktree 的
  // `node_modules/` **目录在、内容空**（`npm ci` 中断留下的），旧实现只判目录存在，
  // 于是把空目录链接进干净检出，前端门禁以 `Cannot find package 'postcss'` 崩掉，
  // 推送被拦在「parity 未通过」——红的是环境，看起来像代码。
  describe('linkModules —— 调用方没装齐依赖时不许假装装好了', () => {
    // 探针文件写死成 `entry.mjs`，不复用真实清单：这条用例测的是「按探针判」，
    // 用完「清单里探什么」由 check-pr-parity.test.mjs 的 probeContents 那组负责。
    const PROBE = ['entry.mjs'];
    const withDirs = (dirs) => {
      const scratch = mkdtempSync(join(tmpdir(), 'link-modules-'));
      const pristine = join(scratch, 'pristine');
      const source = join(scratch, 'source-modules');
      mkdirSync(pristine);
      mkdirSync(source);
      for (const name of dirs) mkdirSync(join(source, name));
      return { scratch, pristine, source };
    };

    it('探针文件一个都没有（空目录）→ 不链接，并点名缺的那个', () => {
      const { scratch, pristine, source } = withDirs([]);
      try {
        const result = linkModules(pristine, source, 'linux', PROBE);
        expect(result.linked).toBe(false);
        expect(result.reason).toContain('entry.mjs');
        expect(existsSync(join(pristine, 'node_modules'))).toBe(false);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });

    it('探针文件在 → 链接成功，干净检出里能看见包', () => {
      const { scratch, pristine, source } = withDirs([]);
      writeFileSync(join(source, 'entry.mjs'), '');
      try {
        const result = linkModules(pristine, source, 'linux', PROBE);
        expect(result.linked).toBe(true);
        expect(existsSync(join(pristine, 'node_modules', 'entry.mjs'))).toBe(true);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });

    it('干净检出里已有 node_modules → 不接链，并说明那不该出现', () => {
      const { scratch, pristine, source } = withDirs([]);
      mkdirSync(join(pristine, 'node_modules'));
      try {
        const result = linkModules(pristine, source, 'linux', PROBE);
        expect(result.linked).toBe(false);
        // 干净检出是刚 `git worktree add` 出来的，`node_modules` 被 gitignore，
        // 里面有东西只可能是调用方灌的 —— reason 得让人看出是「环境不对」而不是「依赖没装」。
        expect(result.reason).toContain('本来不该有');
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  });

  // 2026-11-02 现场：主工作区的 node_modules 三次被清空，每次都发生在 parity 收尾之后，
  // 而同一次故障里 wt24 那个指向主工作区的目录联接退化成空目录。机制没查清（单独试
  // `rmSync` 递归删联接**不会**跟进目标），所以这里不假设机制，只钉住结论：拆链接必须
  // 用只删重解析点的做法，递归删除不许出现在这条路径上。
  describe('unlinkModules —— 只拆链接，不顺着链接删掉别人的包', () => {
    it('链接还在 → 拆掉链接，目标里的包一个不少', () => {
      const scratch = mkdtempSync(join(tmpdir(), 'unlink-modules-'));
      const source = join(scratch, 'source-modules');
      const pristine = join(scratch, 'pristine');
      mkdirSync(source);
      mkdirSync(pristine);
      mkdirSync(join(source, 'postcss'));
      writeFileSync(join(source, 'postcss', 'index.js'), 'module.exports = 1;\n');
      try {
        expect(linkModules(pristine, source, 'linux', ['postcss/index.js']).linked).toBe(true);
        unlinkModules(pristine);
        expect(existsSync(join(pristine, 'node_modules'))).toBe(false);
        expect(readFileSync(join(source, 'postcss', 'index.js'), 'utf8')).toBe(
          'module.exports = 1;\n',
        );
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });

    it('干净检出里没有 node_modules → 什么都不做，也不报错', () => {
      const scratch = mkdtempSync(join(tmpdir(), 'unlink-modules-'));
      try {
        expect(() => unlinkModules(scratch)).not.toThrow();
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });

    it('真目录不是链接 → 不删（它不是我们造的）', () => {
      const scratch = mkdtempSync(join(tmpdir(), 'unlink-modules-'));
      // 落一份**真** node_modules（不是链接）：拆链接的边界就看得见了。
      mkdirSync(join(scratch, 'node_modules', 'postcss'), { recursive: true });
      try {
        expect(() => unlinkModules(scratch)).not.toThrow();
        expect(readdirSync(join(scratch, 'node_modules'))).toEqual(['postcss']);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  });
});

