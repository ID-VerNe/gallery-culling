/**
 * 按下反馈转场（issue #18 · PB-2 + PB-5，issue #38）。
 *
 * ## 防的是什么
 *
 * 43 处 `active:scale-*` 按下缩放按钮原先配 `transition-colors`——
 * `transition-colors` 的 transition-property 不含 transform，按下/回弹
 * 1 帧硬跳（PB-2）。修法是抽 `.press` 组件类，property 显式列 7 个 color
 * 族 + transform，duration-150 ease-out。
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
 * opacity/box-shadow/filter/backdrop-filter——43 站点里有状态切换的
 * opacity/shadow 会被顺带动画。断言 3 钉住「不用 bare transition」。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** 抓所有引号串（单/双/反引号，跨行），返回 {text, line}。 */
function extractStringLiterals(src) {
  const out = [];
  // 三种引号独立匹配，避免混用引号时被吞掉中间内容（CRLF 下字符类 `[\`'"]`
  // 与正则引擎的边界交互不稳，逐引号扫更可靠）。
  const patterns = [
    /'([\s\S]*?)'/g,
    /"([\s\S]*?)"/g,
    /`([\s\S]*?)`/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src))) {
      const text = m[1];
      if (text.length > 400) continue; // 排除长文本/句子
      const line = src.slice(0, m.index).split('\n').length;
      out.push({ text, line });
    }
  }
  return out;
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
    const offenders = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const lits = extractStringLiterals(src);
      for (const { text, line } of lits) {
        if (!/active:scale-/.test(text)) continue;
        if (!/transition-colors\b/.test(text)) continue;
        // 有 transform（transition-transform 或 transition-[...transform]）就不算 PB-2 站点
        if (/transition-transform\b|transition-\[[^\]]*transform[^\]]*\]/.test(text)) continue;
        offenders.push(`${f.replace(/\\/g, '/')}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
