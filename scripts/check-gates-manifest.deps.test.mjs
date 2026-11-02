/**
 * 「parity 的干净检出里缺依赖必须有人撞上」这条元约束（issue #24）。
 *
 * 动机写在这里而不是断言注释里：这条规则的存在本身不直观，改它的人得先知道
 * 它防的是哪种假绿，才能判断「把自己的脚本从清单里删掉」是不是安全。
 *
 * 背景（2026-11-02 推送实测）：`linkModules` 只判 `node_modules` 目录存在，
 * `run-gates` 的 `missingTools` 只查**单个工具文件**在不在。干净检出落在
 * 「目录在、内容空」时两者都是绿的，而 `check-theme-alpha.mjs` 会因为
 * `Cannot find package 'postcss'` 崩掉 —— 正好红在清单里那两条会 import 它的门禁上。
 * 这不是巧合，是清单必须维持的性质：**每一条 check-*.mjs 的外部依赖都有人加载**。
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

  it('只登记在 support 档不算加载（那两档不在 parity 复跑范围）', () => {    const withSupportOnly = {
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
});
