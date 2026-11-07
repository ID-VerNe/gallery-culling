/**
 * 按下反馈转场（issue #18 · PB-2 + PB-5，issue #38）。
 *
 * ## 防的是什么
 *
 * 44 处 `active:scale-*` 按下缩放按钮原先配 `transition-colors`——
 * `transition-colors` 的 transition-property 不含 transform，按下/回弹
 * 1 帧硬跳（PB-2）。修法是抽 `.press` 组件类，property 显式列 7 个 color
 * 族 + transform，duration-150 ease-out。B9 改了 43 处，`ToolbarRow.tsx:233`
 * 因下面的长度过滤被漏判，由 issue #38 补齐（真实集合是 44，不是 43）。
 *
 * ## 为什么用源码/CSS 文本断言
 *
 * - jsdom 不跑 CSS transition，computed style 拿不到 transition-property
 *   的实际值（Tailwind 工具类在 jsdom 下不注入样式表）。
 * - 动效曲线（ease-out 是否真的前段快）jsdom 钉不了，进 needs-live-verify。
 *   这里只钉「规则落盘了」「站点清零了」「collateral 边界守住」。
 *
 * ## 断言 3 的 collateral 边界
 *
 * `.press` 若被贪方便改成 bare `transition`，property 会扩到
 * opacity/box-shadow/filter/backdrop-filter——站点里有状态切换的
 * opacity/shadow 会被顺带动画。断言 3 钉住「不用 bare transition」。
 *
 * ## 提取为什么改成 TypeScript AST（issue #38）
 *
 * 旧实现用三条引号正则跨行扫源码，再用 `text.length > 400` 近似「这不是散文」。
 * 两个方向都错：注释里的撇号/反引号会让正则跨几十行拼出**假字面量**（在
 * `33429f7` 上去掉长度过滤会多报 5 处假站点）；而真实的长 className 模板串
 * （`ToolbarRow.tsx:233`，419 字符）恰好被误杀，从未进入断言。AST 只看真实
 * 字面量节点，注释与 JSX 文本天然不参与，也就不再需要任何长度阈值。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(here, '..', 'index.css');
const css = readFileSync(cssPath, 'utf8');

function walkSrc(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walkSrc(p));
    else if (e.endsWith('.tsx') || e.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * 提取源码里真实存在的字符串字面量，返回 {text, line}。
 *
 * 单/双引号与无插值模板串直接用节点文本；带插值的模板串按 head + 各 span
 * 拼回一个串（插值处写 `${…}` 占位），因为 className 的 token 可能落在
 * 插值前后的任一段。
 */
function extractStringLiterals(file, src) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
  const out = [];
  function push(node, text) {
    out.push({ text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
  }
  function visit(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      push(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const span of node.templateSpans) text += '${…}' + span.literal.text;
      push(node, text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return out;
}

/** PB-2 offender：同串既有 active:scale- 又有 transition-colors，且 transition 不含 transform。 */
function findOffenders(file, src) {
  const offenders = [];
  for (const { text, line } of extractStringLiterals(file, src)) {
    if (!/active:scale-/.test(text)) continue;
    if (!/transition-colors\b/.test(text)) continue;
    // 有 transform（transition-transform 或 transition-[...transform]）就不算 PB-2 站点
    if (/transition-transform\b|transition-\[[^\]]*transform[^\]]*\]/.test(text)) continue;
    offenders.push(`${file.replace(/\\/g, '/')}:${line}`);
  }
  return offenders;
}

describe('issue #38 · .press 组件类落盘（PB-2 + PB-5）', () => {
  it('src/index.css 的 @layer components 内含 .press 规则，@apply 含 transform + duration-150 + ease-out', () => {
    const firstLayer = css.indexOf('@layer components');
    expect(firstLayer).toBeGreaterThan(-1);
    const afterFirstLayer = css.slice(firstLayer);
    // 源 CSS 用 @apply transition-[...] duration-150 ease-out（@apply 在构建期
    // 由 postcss 展开，源文件里就是 @apply 形式，不是 transition-property:）。
    const pressMatch = afterFirstLayer.match(/\.press\s*\{([^}]*)\}/);
    expect(pressMatch).not.toBeNull();
    const body = pressMatch[1];
    // @apply 的 transition-[...] 任意值列表必须含 transform（PB-2 核心：
    // transition-property 不含 transform 是按下硬跳的根因）
    expect(body).toMatch(/transition-\[[^\]]*transform[^\]]*\]/);
    // 7 个 color 族代表：background-color / border-color / color
    expect(body).toMatch(/transition-\[[^\]]*background-color/);
    expect(body).toMatch(/transition-\[[^\]]*border-color/);
    expect(body).toMatch(/transition-\[[^\]]*\bcolor\b/);
    // duration-150（按下反馈要快，不超过 200ms）
    expect(body).toMatch(/duration-150/);
    // ease-out（decelerate，前段快；PB-5 按下路径局部复活的核心）
    expect(body).toMatch(/ease-out/);
  });

  it('.press 的 transition-[...] 列表不含 opacity/box-shadow/filter/backdrop-filter（collateral 边界，禁 bare transition）', () => {
    const firstLayer = css.indexOf('@layer components');
    const afterFirstLayer = css.slice(firstLayer);
    const pressMatch = afterFirstLayer.match(/\.press\s*\{([^}]*)\}/);
    expect(pressMatch).not.toBeNull();
    const body = pressMatch[1];
    // 抓 transition-[...] 任意值里的 property 列表
    const arb = body.match(/transition-\[([^\]]+)\]/);
    expect(arb).not.toBeNull();
    const props = arb[1];
    // bare `transition` 会把 opacity/box-shadow/filter/backdrop-filter 纳进来。
    // 显式列 color 族 + transform 时不应出现这些（collateral 误伤防护）。
    expect(props).not.toMatch(/\bopacity\b/);
    expect(props).not.toMatch(/\bbox-shadow\b/);
    expect(props).not.toMatch(/\bfilter\b/);
    expect(props).not.toMatch(/\bbackdrop-filter\b/);
  });
});

describe('issue #38 · PB-2 核心站点清零（active:scale + transition-colors 无 transform）', () => {
  it('src 下含 active:scale- 的 className 串不再出现 transition-colors 且无 transform', () => {
    const files = walkSrc(resolve(here, '..')).filter((f) => !/\.test\./.test(f));
    const offenders = files.flatMap((f) => findOffenders(f, readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('超过 400 字符的真实模板串仍进入检查（ToolbarRow.tsx:233 的盲区）', () => {
    const longClasses = (
      'focus-ring flex items-center gap-1.5 px-3 py-1 rounded-md active:scale-[0.96] transition-colors ' +
      'font-medium whitespace-nowrap bg-background-surface-hover text-white border border-border-default '
    ).repeat(4);
    expect(longClasses.length).toBeGreaterThan(400);
    expect(findOffenders('fixture.tsx', `const A = \`${longClasses}\`;\n`)).toEqual(['fixture.tsx:1']);
  });

  it('注释里的引号/反引号不算字面量（旧引号正则在这里会造出假站点）', () => {
    const src = [
      '/**',
      ' * 反例：`active:scale-[0.96] transition-colors` 是错的写法，别抄。',
      " * 英文注释里的 don't / it's 也不该被当成字符串起点。",
      ' */',
      'export const A = 1;',
      '',
    ].join('\n');
    expect(extractStringLiterals('fixture.ts', src)).toEqual([]);
    expect(findOffenders('fixture.ts', src)).toEqual([]);
  });
});
