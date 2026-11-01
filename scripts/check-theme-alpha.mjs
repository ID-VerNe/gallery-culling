/**
 * 主题色透明度门禁（issue #15）。
 *
 * ## 防的是什么
 *
 * Tailwind 3 的 `/NN` 修饰需要**能解析出通道值**才能拼出 `rgb(... / a)`。本仓
 * `tailwind.config.js` 把背景/边框色映射成 `var(--color-*)` 之后，`bg-background-base/90`
 * 这类类名**一条规则都不产出**，页面静默回退成透明 —— 不报错、不红、没有任何提示。
 *
 * 2026-11-01 实测：整个应用的「半透明暗底 + 虚化」材质实际是缺失的，26 处使用点全部
 * 失效，靠肉眼在深色截图上完全看不出来。这类「构建期静默丢弃」只有机器检查能盯住。
 *
 * ## 为什么是动态扫描而不是硬编码清单
 *
 * 硬编码 `bg-background-base/90` 只能防住今天这一条。这里反过来做：**扫源码里实际用到的
 * 颜色+透明度组合**，再去产物里逐个核对。谁明天加了 `bg-background-base/55`，门禁自动覆盖。
 *
 * ## 为什么在内存里编译
 *
 * 真实构建走 `dist/`，门禁不该依赖「有人先跑过 build」。这里用 postcss 在内存里把
 * `src/index.css` 跑一遍 Tailwind，产物只存在于字符串里。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 匹配 `bg-<theme>/<NN>` 形式的类名。
 *
 * 刻意**只认** `background.` / `border.` / `button.` 这三族自定义配色里的
 * `background-base` 这类**多段**名字，不匹配 `bg-white/10` / `bg-black/50`
 * 这些 Tailwind 内置色 —— 内置色本来就是字面量，天然支持 `/NN`，把它们纳入
 * 会让门禁对着已知能工作的东西空转。
 */
const THEME_ALPHA_RE = /\b(bg|border|text|ring|from|to|via)-((?:background|border|button)(?:-[a-z][a-z-]*)?)\/(\d{1,3})\b/g;

/**
 * 从一段源码文本里抽出所有「主题色 + 透明度」组合。
 *
 * 返回 `{ color, alpha, utility }` 的数组（去重后）。`utility` 保留完整类名，
 * 报错时能直接告诉人「是哪个类出了问题」。
 *
 * 纯函数，便于单测与变异。
 */
export function extractThemeAlphaClasses(source) {
  const found = new Map();
  for (const match of source.matchAll(THEME_ALPHA_RE)) {
    const [, utility, color, alpha] = match;
    const key = `${utility}-${color}/${alpha}`;
    if (!found.has(key)) found.set(key, { utility, color, alpha });
  }
  return [...found.values()];
}

/**
 * 判定每个组合在编译产物里是否真的有规则。
 *
 * Tailwind 会把 `/` 转义成 `\/`，所以要在产物里找 `<utility>-<color>\/<NN>`。
 *
 * 纯函数：`groups` 来自 `extractThemeAlphaClasses`，`css` 是编译产物全文。
 */
export function judgeThemeAlpha(groups, css) {
  const missing = groups.filter(({ utility, color, alpha }) => {
    // 例如 `.bg-background-base\/90`。Tailwind 产物里 `/` 是**单个**反斜杠转义，
    // 用 String.raw 避免模板字符串把它再转义一次。
    const selector = String.raw`${utility}-${color}\/${alpha}`;
    return !css.includes(selector);
  });

  if (missing.length === 0) {
    return {
      ok: true,
      message: `PASS: ${groups.length} 个主题色透明度类全部产出规则（issue #15）。`,
    };
  }

  const list = missing.map(({ utility, color, alpha }) => `  ${utility}-${color}/${alpha}`).join('\n');
  return {
    ok: false,
    message:
      `FAIL: ${missing.length} 个主题色透明度类在编译产物里没有规则：\n${list}\n` +
      '  这多半是配色被映射成了 `var(--color-*)` 字面量 —— Tailwind 3 无法对它应用 /NN，\n' +
      '  规则会被**静默丢弃**（不报错、不警告）。\n' +
      '  处置：给该颜色加一个通道三元组令牌（如 `--color-bg-base-rgb: 10 10 10;`），\n' +
      '  配置写成 `rgb(var(--color-bg-base-rgb) / <alpha-value>)`。详见 issue #15。',
  };
}

/**
 * 递归收集 `src/` 下的源码文件。
 *
 * 只收 `.ts` / `.tsx`（Tailwind content 也是这两类），跳过测试文件 —— 测试里出现的
 * 类名断言不代表真的渲染，把它们算进来会让门禁对着「测试字符串」做无用功。
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

/** 把 `src/` 下所有源码里的主题色透明度组合收集起来。 */
export function scanThemeAlphaUsage(files = collectSourceFiles()) {
  const merged = new Map();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const group of extractThemeAlphaClasses(source)) {
      const key = `${group.utility}-${group.color}/${group.alpha}`;
      if (!merged.has(key)) merged.set(key, { ...group, file: relative(ROOT, file) });
    }
  }
  return [...merged.values()];
}

/**
 * 在内存里用 Tailwind 编译 `src/index.css`，返回产物全文。
 *
 * ⚠️ 这里**刻意自己 import 配置再传对象**，不把 `config: <路径>` 交给 Tailwind。
 * 原因：Tailwind 拿到路径时会用 `jiti` 去加载，而 jiti 在 vitest 的 ESM 环境里
 * 会抛 `Cannot set property require of [object Object] which has only a getter`，
 * 产物变成残缺的（规则静默消失），看起来像「配色配置坏了」——是个会把人带偏的假象。
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
  const groups = scanThemeAlphaUsage();
  if (groups.length === 0) {
    console.log('PASS: 源码里没有「主题色 + 透明度」类，无需检查（issue #15）。');
    return 0;
  }
  const css = await buildCss();
  const verdict = judgeThemeAlpha(groups, css);
  (verdict.ok ? console.log : console.error)(verdict.message);
  return verdict.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
