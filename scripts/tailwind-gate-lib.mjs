/**
 * Tailwind 两门禁共享脚手架（issue #127）。
 *
 * `check-theme-alpha.mjs`（issue #15）与 `check-borders-emitted.mjs`（issue #18）
 * 都需要在内存里编译 `src/index.css` 并扫源码，本库就放这两段逐字重复的逻辑：
 * 递归收集 `src/` 下的源码文件、以及在内存里跑 Tailwind 编译。
 *
 * 两门禁转 `import` + `re-export`，测试网（`check-*.test.mjs` 直接 import
 * `collectSourceFiles` / `buildCss` / `ROOT`）一行不动。
 *
 * ⚠️ `postcss` / `tailwindcss` 的 import 刻意留在这里与两门禁的直引重复：
 * `check-gates-manifest.mjs` 的 `depProblems` 只看 `check-*.mjs` 的字面量外部
 * import，两门禁保留直引是为了 `loaded` 仍含此二包（parity 空 `node_modules`
 * 时 fail-closed，issue #24）。删掉直引只会让 fail-closed 保证静默消失。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
