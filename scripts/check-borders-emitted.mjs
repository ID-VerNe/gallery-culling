/**
 * 描边类门禁（issue #18 · PD-1）。
 *
 * ## 防的是什么
 *
 * `tailwind.config.js` 里 `border` 是**独立命名空间**：
 *
 * ```js
 * border: { subtle: ..., default: ..., strong: ... }
 * ```
 *
 * 它生成的是 `border-border-default`（`borderColor` 前缀 + 命名空间名 + 键名），
 * 而不是 `border-default`。写后者时 Tailwind **一条规则都不产出**——不报错、
 * 不警告、不红。元素回落到 `currentColor`，而 `body` 继承 `text-white`，
 * 于是「失效的描边」看起来是 100% 白线，肉眼极难发现。
 *
 * 2026-11-02 实测（master `4a5b0a5`）：45 处裸 `border-default` 分布在 20 个文件，
 * 全部静默失效；另有 12 处已写对的 `border-border-default`。全站 57 处统一形态。
 *
 * ## 为什么和 check-theme-alpha.mjs 分开
 *
 * issue #15 那条防的是「类名写对了、但颜色值是 `var()` 字面量导致 `/NN` 被丢弃」，
 * 判据是「产物里有没有该类的规则」。这条防的是「类名本身就写错了」，
 * 判据是「源码里用到的描边类，产物里是否有对应规则」。前者靠正则识别
 * `bg-xxx/NN`，后者要识别任意 `border-*`，重叠但不等价，合成一条会互相削弱。
 *
 * ## 为什么是动态扫描
 *
 * 硬编码一个 `border-default` 黑名单只能防住今天这一条。这里反过来：
 * **扫源码里所有描边相关的类，逐个去产物里核对**。谁明天加了
 * `border-foo` 而配置里没这键，门禁自动覆盖。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 匹配 `border-<name>` 形式的类名（含 `border-t`/`border-b` 这类方位前缀）。
 *
 * 只认「边框颜色」候选，三类一律跳过：
 *   - 宽度类（`border-2`、`border-r-0`、`border-[3px]`）：首字符是数字或 `[`
 *   - 样式类（`border-solid` 等）：见 `NON_COLOR_BORDER`
 *   - 任意值表达式内部（`transition-[border-color,transform]`）：见下方的
 *     `ARBITRARY_VALUE_RE` 预剥离
 *
 * 刻意**不匹配** `border-white/20` 这类内置色写法：内置调色板天然支持 `/NN`，
 * 纳入只会让门禁对着已知能工作的东西空转。
 */
const BORDER_CLASS_RE = /\bborder(?:-[a-z0-9]+)+\b/g;

/**
 * `tailwind.config.js` 里 `theme.extend.colors.border` 的键 —— 描边色只认这些。
 *
 * 为什么要白名单，而不是「只要产物里有规则就放过」：`border-background-input`、
 * `border-button` 这类写法在 Tailwind 3.4 下**确实会**从 `colors` 根键提升出规则
 * （`background.input` / `button` 都在 `colors` 下），于是编译成功——但那个颜色
 * 是**背景色调色板**里的值，语义上根本不是描边。写它的人多半是想给输入框描边，
 * 实际拿到的却是背景色，而且没有人会注意到。
 *
 * 门禁的职责是钉住「描边色只该来自 `border` 命名空间」这条不变量，所以不在
 * 这份表里的键一律判红，报错文案直接说明该去哪加。新增描边色时**必须**同步
 * 这里 —— 这是刻意付出的代价，换的是没有绕过它的写法。
 */
const BORDER_NAMESPACE_KEYS = new Set(['subtle', 'default', 'strong']);

/** Tailwind 内置基础色名（`border-white`、`border-transparent` 等）。 */
const BUILTIN_PALETTE = new Set(['white', 'black', 'transparent', 'current', 'inherit']);

/** Tailwind 内置色阶（`border-sky-500`、`border-gray-700/50`）。 */
const BUILTIN_SCALE_RE =
  /^(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}$/;

/**
 * 解析结果不是描边色、而是「写了不属于 `border` 命名空间的键」—— 必须判红。
 * 用前缀标记把它和 `null`（不是描边色类，跳过）区分开。
 */
export const INVALID_NAMESPACE_MARKER = '!namespace:';

/**
 * 把 `border-t-2` / `border-border-default` 这类完整类名解析成颜色键。
 *
 * 返回 `null` 表示「这不是描边色类」：
 *   - 方位前缀 + 数字（`border-r-0`）或任意值（`border-t-[3px]`）
 *   - 样式词（`border-solid`）
 *   - 孤立的 `border-t` / `border-x`（方位宽度），不带宽度值时是 1px 边框
 *   - Tailwind 内置调色板（`border-white`、`border-sky-500`）
 *
 * 返回 `INVALID_NAMESPACE_MARKER + key` 表示「是描边色类，但键不在 `border`
 * 命名空间里」（`border-button`、`border-background-input`）—— 这类必须判红。
 *
 * ⚠️ `theme.extend.colors` 下的**每个**根键都是合法的 `border-*` 颜色来源
 * （Tailwind 把 `colors` 整体并入 `borderColor`）。所以「配置根键」不是越界，
 * 是**另一个调色板**：`border-background-input` 编译成
 * `border-color: var(--color-bg-input)`，能跑、也没报错——只是语义上是背景色。
 * 门禁要拦的正是这种「编译得通但用错了调色板」的写法，靠白名单拦。
 *
 * 注意 `BORDER_CLASS_RE` 不认 `/`，所以 `/NN` 修饰不会走到这里：内置色的
 * `/NN` 写法在正则层就已经被排除，而主题色今天零处使用 `/NN`。
 */
function parseBorderColorKey(className) {
  const parts = className.split('-').slice(1); // 去掉开头的 `border`
  const DIRS = new Set(['t', 'r', 'b', 'l', 'x', 'y', 's', 'e']);
  if (parts.length > 1 && DIRS.has(parts[0])) parts.shift();
  if (parts.length === 0) return null;
  const key = parts.join('-');
  // 孤立方位（`border-t` / `border-x`）= 该侧 1px 边框，是宽度修饰符不是颜色。
  if (parts.length === 1 && DIRS.has(key)) return null;
  if (/^\d/.test(key)) return null;
  if (NON_COLOR_BORDER.has(key)) return null;
  if (BUILTIN_PALETTE.has(key) || BUILTIN_SCALE_RE.test(key)) return null;

  // 本仓 `border` 命名空间：配置键是 `border-subtle/default/strong`，编译出的
  // 类名是 `border-border-<key>`，所以裸键必须以 `border-` 开头。
  if (!key.startsWith('border-')) return INVALID_NAMESPACE_MARKER + key;
  const configKey = key.slice('border-'.length);
  if (!BORDER_NAMESPACE_KEYS.has(configKey)) return INVALID_NAMESPACE_MARKER + key;
  return key;
}

/** 方括号任意值表达式，如 `transition-[border-color,transform]`。 */
const ARBITRARY_VALUE_RE = /\[[^\]]*\]/g;

/** 宽度/样式等非颜色的 `border-*` 取值，核对颜色规则时排除。 */
const NON_COLOR_BORDER = new Set([
  'solid',
  'dashed',
  'dotted',
  'double',
  'none',
  'hidden',
  'collapse',
  'separate',
]);

/**
 * 从一段源码文本里抽出所有「描边颜色」候选类。
 *
 * 返回去重后的类名键数组（如 `['border-default', 'border-border-subtle']`），
 * 报错时能直接告诉人「是哪一处」。纯函数，便于单测与变异。
 *
 * 键名带 `INVALID_NAMESPACE_MARKER` 前缀的，是「写了描边类、但键不在 `border`
 * 命名空间里」的写法（`border-button`）—— 它们不静默跳过，而是交给
 * `judgeBorderClasses` 判红。
 */
export function extractBorderClasses(source) {
  // 先剥掉 `[...]` 任意值表达式：里面的 `border-color` 是 CSS 属性名，
  // 不是 Tailwind 类名，留着会在产物里找不到规则而误报。
  const stripped = source.replace(ARBITRARY_VALUE_RE, ' ');
  const found = new Set();
  for (const match of stripped.matchAll(BORDER_CLASS_RE)) {
    const key = parseBorderColorKey(match[0]);
    if (key) found.add(key);
  }
  return [...found];
}

/**
 * 判定每个描边类在编译产物里是否真的有规则。
 *
 * Tailwind 产物的选择器是 `.border-<key>`（如 `.border-border-default`）。
 * 用 `includes` 而不是正则：类名里的 `-` 在 CSS 里不需要转义，直接比较字面量
 * 既可读又不会因为正则元字符（例如将来出现 `.` 或 `/`）而误判。
 *
 * 纯函数：`keys` 来自 `extractBorderClasses`，`css` 是编译产物全文。
 */
export function judgeBorderClasses(keys, css) {
  // 命名空间违规单独分流：它们的产物规则**可能确实存在**（Tailwind 会从
  // `colors` 根键提升出 `border-button`），所以「产物里有没有规则」判不出来，
  // 必须按不变量判。
  const offNamespace = keys.filter((k) => k.startsWith(INVALID_NAMESPACE_MARKER));
  if (offNamespace.length > 0) {
    const list = offNamespace
      .map((k) => `  border-${k.slice(INVALID_NAMESPACE_MARKER.length)}`)
      .join('\n');
    return {
      ok: false,
      message:
        `FAIL: ${offNamespace.length} 个描边类的键不在 \`border\` 命名空间里：\n${list}\n` +
        '  本仓描边色只有 `theme.extend.colors.border` 下的键。`border-button` 之流\n' +
        '  即便能编译，取到的也是 `colors.button`（背景色）的值，不是描边色。\n' +
        '  要么改用 `border-border-default` 这类正确写法，要么先往 tailwind.config.js\n' +
        '  的 `colors.border` 里加键并同步 scripts/check-borders-emitted.mjs。\n' +
        '  详见 issue #18。',
    };
  }

  const missing = keys.filter((key) => {
    // 两端加边界，防止 `.border-border-default` 命中 `.border-border-default-foo`
    const selector = `.border-${key}`;
    const idx = css.indexOf(selector);
    if (idx === -1) return true;
    const after = css[idx + selector.length];
    // 类名后必须是 `{`、`,`、空格、`:`、`.` 等分隔符，不能是 `-` 或字母数字
    return after !== undefined && /[a-z0-9_-]/i.test(after);
  });

  if (missing.length === 0) {
    return {
      ok: true,
      message: `PASS: ${keys.length} 个描边类全部产出规则（issue #18 · PD-1）。`,
    };
  }

  const list = missing.map((k) => `  border-${k}  → 产物里应有 .border-${k}`).join('\n');
  return {
    ok: false,
    message:
      `FAIL: ${missing.length} 个描边类在编译产物里没有规则：\n${list}\n` +
      '  这多半是类名写错了：`tailwind.config.js` 的 `border` 是独立命名空间，\n' +
      '  配置 `border.default` 生成的是 `border-border-default`，**不是** `border-default`。\n' +
      '  写错时 Tailwind 静默丢弃，元素回落 currentColor（本仓 body 为 text-white，\n' +
      '  所以看起来是 100% 白线）。详见 issue #18。',
  };
}

/**
 * 递归收集 `src/` 下的源码文件。
 *
 * 只收 `.ts` / `.tsx`，跳过测试文件 —— 测试里的类名断言不代表真的渲染。
 */
export function collectSourceFiles(dir = join(ROOT, 'src'), acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\.(ts|tsx)$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

/** 把 `src/` 下所有源码里的描边类收集起来。 */
export function scanBorderUsage(files = collectSourceFiles()) {
  const merged = new Map();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const key of extractBorderClasses(source)) {
      if (!merged.has(key)) merged.set(key, { key, file: relative(ROOT, file) });
    }
  }
  return [...merged.values()];
}

/**
 * 在内存里用 Tailwind 编译 `src/index.css`，返回产物全文。
 *
 * ⚠️ 同 check-theme-alpha.mjs：**刻意自己 import 配置再传对象**，不把
 * `config: <路径>` 交给 Tailwind —— jiti 在 vitest 的 ESM 环境里会抛
 * `Cannot set property require of ...`，产物残缺，看起来像「配置坏了」。
 */
export async function buildCss() {
  const input = readFileSync(join(ROOT, 'src/index.css'), 'utf8');
  const configModule = await import(pathToFileURL(join(ROOT, 'tailwind.config.js')).href);
  const config = configModule.default ?? configModule;
  const result = await postcss([tailwindcss(config)]).process(input, {
    from: join(ROOT, 'src/index.css'),
  });
  return result.css;
}

export async function main() {
  const used = scanBorderUsage();
  if (used.length === 0) {
    console.log('PASS: 源码里没有描边颜色类，无需检查（issue #18 · PD-1）。');
    return 0;
  }
  const css = await buildCss();
  const verdict = judgeBorderClasses(
    used.map((u) => u.key),
    css,
  );
  (verdict.ok ? console.log : console.error)(verdict.message);
  return verdict.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
