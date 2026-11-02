/**
 * 描边类门禁的单测（issue #18 · PD-1）。
 *
 * 重点是**每条判定分支都要能被变异打红**：
 *   - 抽取：颜色类收、宽度类/样式类/CSS 属性名不收
 *   - 抽取：方括号里的真实类引用不能漏（含写错的那个）
 *   - 判定：产物缺规则时必须红
 *   - 产物级：`judgeBorderClasses` 吃真实编译产物，写对的名字必须有规则
 *
 * 刻意**不**在这里断言「仓库现状必须红」—— 那会让这个测试文件在 PR 里
 * 表现为「修完反而红」。仓库级的红/绿由门禁脚本自己在 gates 里负责。
 */
import { describe, expect, it } from 'vitest';
import {
  INVALID_NAMESPACE_MARKER,
  buildCss,
  extractBorderClasses,
  judgeBorderClasses,
  scanBorderUsage,
} from './check-borders-emitted.mjs';

describe('extractBorderClasses', () => {
  it('抽出主题描边颜色类', () => {
    // 注意正确写法是 `border-border-subtle`（见下一条）；这里只验抽取的键形态。
    expect(extractBorderClasses('<div className="border border-border-subtle" />')).toEqual([
      'border-subtle',
    ]);
  });

  it('抽出带命名空间前缀的完整类名', () => {
    // `border-border-default` 的完整键是 `border-default`（前缀 border + 键名
    // border-default），不是 `default`。这条区分是对本地门禁自身的防错。
    expect(extractBorderClasses('border-border-default border-border-strong')).toEqual([
      'border-default',
      'border-strong',
    ]);
  });

  it('不带出方位前缀后面的颜色键（border-t-subtle → subtle）', () => {
    // 方位前缀被剥掉后，`border-t-subtle` 的键是 `subtle`；而
    // `border-b-border-default` 去掉方位后仍是 `border-default`（不是 `default`）。
    expect(extractBorderClasses('border-t-border-subtle border-b-border-default')).toEqual([
      'border-subtle',
      'border-default',
    ]);
  });

  it('排除宽度类', () => {
    // 这三类都不是颜色：纯数字、方位+数字、方位+任意值
    expect(extractBorderClasses('border-2 border-r-0 border-t-[3px]')).toEqual([]);
  });

  it('排除样式类', () => {
    expect(extractBorderClasses('border-solid border-dashed border-none')).toEqual([]);
  });

  it('排除任意值表达式内部的 CSS 属性名', () => {
    // `transition-[border-color,transform]` 里的 border-color 是属性名不是类名
    expect(extractBorderClasses('transition-[border-color,transform]')).toEqual([]);
    expect(
      extractBorderClasses('transition-[background-color,border-color,box-shadow,transform]'),
    ).toEqual([]);
  });

  it('任意值表达式内部的描边类不能漏（2026-11-02 评审注入实测漏过）', () => {
    // `transition-[border-default,transform]` 是**真实写错**的类引用：Tailwind
    // 会生成一条属性名无效、被静默丢弃的 transition-property —— 正是本门禁
    // 要防的静默失效。整段剥离方括号会让它对门禁失明。
    expect(extractBorderClasses('transition-[border-default,transform]')).toEqual([
      `${INVALID_NAMESPACE_MARKER}default`,
    ]);
    expect(extractBorderClasses('transition-[border-border-subtle,transform]')).toEqual([
      'border-subtle',
    ]);
  });

  it('任意值里值与键名巧合拼接的 token 按类名语义收下（误报方向安全）', () => {
    // `calc(border-border-strong)` 里的 `border-border-strong` 单看就是合法类名，
    // 本门禁不做值语义分析，收下它。代价：主题键被删时这处会多报一条 —— 而那
    // 正是门禁该报的时刻。反之若为了绕开它去判形态，`transition-[border-…]`
    // 里的真实类引用会被一起漏掉（2026-11-02 评审实测的同一类盲区）。
    expect(extractBorderClasses('w-[calc(border-border-strong)]')).toEqual(['border-strong']);
  });

  it('带 /NN 的主题描边类同样被认出', () => {
    // `BORDER_CLASS_RE` 不认 `/`，裸写法会整条漏掉；`border-border-default/50`
    // 的键仍是 `border-default`（Tailwind 对十六进制主题色能正常加透明度）。
    expect(extractBorderClasses('border-border-default/50')).toEqual(['border-default']);
  });

  it('把非 border 命名空间的键标记出来，而不是静默跳过', () => {
    // `border-button` / `border-background-input` 能编译（Tailwind 从 colors
    // 根键提升），但取到的是背景色，不是描边色 —— 必须判红。
    expect(extractBorderClasses('border-button border-background-input')).toEqual([
      `${INVALID_NAMESPACE_MARKER}button`,
      `${INVALID_NAMESPACE_MARKER}background-input`,
    ]);
  });

  it('带 border- 前缀但键不在白名单的，同样标红', () => {
    // 这条钉住 `BORDER_NAMESPACE_KEYS` 白名单本身。上面那条用例的键（`button` /
    // `background-input`）不含 `border-` 前缀，走的是更早的「必须以 border- 开头」
    // 分支 —— 删掉白名单那一行它们照样红，所以测不出白名单是否还在。
    // 只有多段键（`border-bogus`）才走白名单分支：它形式上是本命名空间的写法，
    // 但配置里没这个键。
    expect(extractBorderClasses('border-border-bogus')).toEqual([
      `${INVALID_NAMESPACE_MARKER}border-bogus`,
    ]);
  });

  it('放过 Tailwind 内置调色板（border-white / border-sky-500）', () => {
    expect(extractBorderClasses('border-white border-transparent border-sky-500')).toEqual([]);
  });

  it('同一类名出现多次只算一次', () => {
    expect(extractBorderClasses('border-border-subtle x border-border-subtle')).toEqual([
      'border-subtle',
    ]);
  });
});

describe('judgeBorderClasses', () => {
  it('产物里有规则时通过', () => {
    const verdict = judgeBorderClasses(['subtle'], '.border-subtle{border-color:red}');

    expect(verdict.ok).toBe(true);
    expect(verdict.message).toContain('PASS');
  });

  it('产物里没有规则时判红并指出是哪个类', () => {
    const verdict = judgeBorderClasses(['default'], '.border-subtle{border-color:red}');

    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('border-default');
  });

  it('键不在 border 命名空间时判红，并指出去哪加键', () => {
    // 产物里**有** `.border-button` 规则（Tailwind 从 colors.button 提升），
    // 所以不能靠「有没有规则」判，必须按命名空间不变量判。
    const verdict = judgeBorderClasses(
      [`${INVALID_NAMESPACE_MARKER}button`],
      '.border-button{border-color:#222}',
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('border-button');
    expect(verdict.message).toContain('theme.extend.colors.border');
  });

  it('报了违规范畴就整体判红，不因其余类都正常而放过', () => {
    const verdict = judgeBorderClasses(
      [`${INVALID_NAMESPACE_MARKER}button`, 'subtle'],
      '.border-button{border-color:#222}.border-subtle{border-color:red}',
    );

    expect(verdict.ok).toBe(false);
  });

  it('前缀相同的更长类名不算命中（防止 substring 假绿）', () => {
    // `.border-defaults` 是另一个类，不能当成 `.border-default` 存在
    const verdict = judgeBorderClasses(['default'], '.border-defaults{border-color:red}');

    expect(verdict.ok).toBe(false);
  });
});

describe('产物级：写对的名字必须真的有规则', () => {
  it('border-border-default 在编译产物里存在（这是正确写法）', async () => {
    const css = await buildCss();
    const verdict = judgeBorderClasses(['border-default'], css);

    expect(verdict.ok).toBe(true);
  });

  it('border-button 即便产物里有规则，门禁仍须判红', async () => {
    // 这条盯的是「白名单不是多余的」：光看产物规则会放过它。
    //
    // 产物里**现在**没有 `.border-button` —— `buildCss()` 用真实 content 扫
    // src/，而 src 里没人这么写。所以这里不去断言产物形态（那只是复述
    // Tailwind 的行为），只断言门禁口径：拿到这个键就必须红。
    const css = await buildCss();
    const keys = extractBorderClasses('border-button');

    expect(judgeBorderClasses(keys, css).ok).toBe(false);
  });

  it('border-default（漏了命名空间前缀）在编译产物里不存在（这是缺陷形态）', async () => {
    const css = await buildCss();
    const verdict = judgeBorderClasses(['default'], css);

    expect(verdict.ok).toBe(false);
  });
});

describe('scanBorderUsage', () => {
  it('源码里没有越界的描边键（border-button 之流）', () => {
    const used = scanBorderUsage();
    const offenders = used.filter((u) => u.key.startsWith(INVALID_NAMESPACE_MARKER));

    expect(offenders).toEqual([]);
  });

  it('源码里不再使用漏了前缀的 border-default', () => {
    // 这是本 issue 的验收口径：修复后 src 里不应再有裸的 border-default
    const used = scanBorderUsage();
    const offenders = used.filter((u) => u.key === 'default');

    expect(offenders).toEqual([]);
  });
});
