/**
 * 「parity 的干净检出里缺依赖必须有人撞上」这条元约束（issue #24）。
 *
 * 动机写在这里而不是断言注释里：这条规则的存在本身不直观，改它的人得先知道
 * 它防的是哪种假绿，才能判断「把自己的脚本从清单里删掉」是不是安全。
 *
 * 背景（2026-11-02 推送实测）：干净检出里的 `node_modules` 可能落在「目录在、内容空」
 * 的状态，`check-theme-alpha.mjs` 会因此以 `Cannot find package 'postcss'` 崩掉。
 * 崩溃本身是对的（门禁 fail-closed），要点在于**必须有一条 ci 门禁真的走到那个包**，
 * 否则整条 parity 会在一个坏掉的环境上判 PASS。这就是清单要维持的性质：
 * 每一条 check-*.mjs 的外部依赖都落在某条 ci 门禁的加载路径上。
 */
import { describe, expect, it } from 'vitest';
import { depProblems, externalImports } from './check-gates-manifest.mjs';

const row = (name, bucket = 'ci') => ({ name, bucket });

describe('externalImports', () => {
  it('认出裸包名，node: 内置与相对路径不算', () => {
    expect(
      externalImports(
        "import postcss from 'postcss';\nimport { join } from 'node:path';\nimport x from './y.mjs';",
      ),
    ).toEqual(['postcss']);
  });

  it('scoped 包保留 @scope/name，子路径只留包名', () => {
    expect(externalImports("import a from '@tailwindcss/forms';")).toEqual(['@tailwindcss/forms']);
    expect(externalImports("import b from 'postcss/lib/parser';")).toEqual(['postcss']);
  });

  it('一个包多处引用只报一次，结果稳定排序', () => {
    expect(
      externalImports("import a from 'vitest';\nimport b from 'postcss';\nimport c from 'postcss';"),
    ).toEqual(['postcss', 'vitest']);
  });

  it('没有 import 时是空数组（不是 undefined）', () => {
    expect(externalImports('console.log(1);')).toEqual([]);
  });

  it('副作用 import / 动态 import / require 都算（漏掉它们就留了后门）', () => {
    expect(externalImports("import 'postcss';")).toEqual(['postcss']);
    expect(externalImports("const m = await import('tailwindcss');")).toEqual(['tailwindcss']);
    expect(externalImports("const p = require('postcss/lib/parser');")).toEqual(['postcss']);
    expect(externalImports("export { default } from 'postcss';")).toEqual(['postcss']);
  });

  it('动态 import 里的相对路径 / node: 内置同样跳过', () => {
    expect(externalImports("await import('./local.mjs');\nawait import('node:fs');")).toEqual([]);
  });

  it('标识符里的 import 字样不算（importments / reimport）', () => {
    expect(externalImports("const reimported = 1;\nfoo.import('postcss');")).toEqual([]);
  });
});

describe('depProblems —— 每个 check-*.mjs 的外部依赖都要有人加载', () => {
  const manifest = (names) => ({ ci: names.map((name) => row(name)) });

  it('依赖被某条 ci 门禁加载 → 绿', () => {
    expect(
      depProblems(
        [{ name: 'check-a.mjs', source: "import postcss from 'postcss';" }],
        manifest(['check-a.mjs']),
      ),
    ).toEqual([]);
  });

  it('依赖只被另一条门禁加载也算绿（同类包不必重复登记）', () => {
    expect(
      depProblems(
        [
          { name: 'check-a.mjs', source: "import postcss from 'postcss';" },
          { name: 'check-b.mjs', source: "import postcss from 'postcss';" },
        ],
        manifest(['check-a.mjs', 'check-b.mjs']),
      ),
    ).toEqual([]);
  });

  it('本脚本登记了，但它 new 出来的依赖没有 ci 门禁会加载 → 红并点名包', () => {
    const problems = depProblems(
      [{ name: 'check-a.mjs', source: "import postcss from 'postcss';" }],
      manifest([]),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('postcss');
    expect(problems[0]).toContain('check-a.mjs');
  });

  it('只登记在 support 档不算加载（那两档不在 parity 复跑范围）', () => {
    const withSupportOnly = {
      ci: [],
      support: [{ name: 'check-a.mjs' }],
    };
    expect(
      depProblems([{ name: 'check-a.mjs', source: "import postcss from 'postcss';" }], withSupportOnly),
    ).toHaveLength(1);
  });

  it('非 check-*.mjs 的脚本不受管（release.mjs / *.test.mjs 不在清单管辖内）', () => {
    expect(
      depProblems(
        [
          { name: 'release.mjs', source: "import fs from 'fs';" },
          { name: 'gates.test.mjs', source: "import { it } from 'vitest';" },
        ],
        manifest([]),
      ),
    ).toEqual([]);
  });

  it('清单登记了但磁盘没这份源码时按「没有外部依赖」处理，不误报', () => {
    expect(depProblems([], manifest(['check-ghost.mjs']))).toEqual([]);
  });

  it('脚本自己就是 ci 门禁时不查自己（它的依赖在 list 里、不在自己身上）', () => {
    expect(
      depProblems(
        [{ name: 'check-a.mjs', source: "import v from 'vitest';" }],
        manifest(['check-a.mjs']),
      ),
    ).toEqual([]);
  });

  it('副作用 import 的包没人加载时同样报红', () => {
    const problems = depProblems([{ name: 'check-a.mjs', source: "import 'postcss';" }], manifest([]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('postcss');
  });

  it('vitest 自己不当成「被加载」：被别的门禁 import 才绿，否则照报', () => {
    expect(
      depProblems(
        [
          { name: 'check-a.mjs', source: "import { describe } from 'vitest';" },
          { name: 'check-b.mjs', source: "import { describe } from 'vitest';" },
        ],
        manifest(['check-a.mjs', 'check-b.mjs']),
      ),
    ).toEqual([]);
    const problems = depProblems(
      [{ name: 'check-b.mjs', source: "import { describe } from 'vitest';" }],
      manifest(['check-a.mjs']),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('vitest');
  });
});
