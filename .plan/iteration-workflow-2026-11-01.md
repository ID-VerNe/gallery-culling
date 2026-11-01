# 迭代流程对齐 IdleJot — 实施方案（2026-11-01）

对应 issue：#6 `[规范] 迭代流程对齐 IdleJot`

---

## 1. 现状

仓库里**只有** `AGENTS.md` 一份协作说明，且它只管「红线 + 架构现状 + 环境坑」。
改动流程（issue → plan → worktree → PR → 回签）没有落纸：本次 #4 → PR #5 是口头约定，
分支名不带 issue 号、PR 无固定分段、合并即关单、假红靠临场归因。

没有 `.github/`、没有 `.githooks/`、没有门禁清单。AGENTS 红线 1 的四条命令是
**正文里的一段散文**，没有执行器、没有 CI、改错了也没人拦。

参照对象 IdleJot（`C:\Users\VerNe\Downloads\Documents\Tulpa`）已经把这套跑通。

## 2. 移植什么 / 不移植什么

| IdleJot 的做法 | 本仓怎么落 | 为什么 |
|---|---|---|
| §2.7 五步流程（issue → plan → worktree → PR → 对账/回签） | **照搬** | 与本仓技术栈无关，是纯流程 |
| `doc/ISSUE_GUIDE.md` / `doc/PR_GUIDE.md` | **照搬结构**，删掉隐私门禁、QQ 群、`.venv` 相关 | 本仓没有需要保护的私有数据 |
| `scripts/gates.json` + `run_gates.py` | `scripts/gates.json` + `scripts/run-gates.mjs` | 本仓是 npm 工程、`scripts/release.mjs` 已是 Node，不引 Python |
| 91 条 `check_*.py` | **只留 2 条自写门禁**（元清单校验、fmt 基线守卫），其余直接是 `tsc` / `vitest` / `cargo test` | 本仓的验证面就是这三条命令，不需要为每条造一个脚本 |
| 5 个分片（static/runtime/mcp/storage/reply） | 3 个：`static` / `unit` / `rust`；真窗口 e2e 进 `manual` 档 | CI 跑不了 WebView2 真窗口（AGENTS 环境坑已记录） |
| `.githooks/commit-msg`（发布门禁） | commit 文案规范：`type(scope): 摘要`、禁止 `Co-Authored-By:`、merge 豁免 | 对应本仓既有的 commit 约定 |
| `.githooks/pre-push`（发布门禁 + parity） | 推送前跑 `static` 分片（`SKIP_GATES=1` 可跳过并留痕） | 全量太重（cargo 冷编 10 分钟），static 是「最便宜、最先红」的一档 |
| CI 分片矩阵 + `checks` 汇总 job | 同结构，`windows-latest` | 本仓仅 Windows |
| 分支保护 / CODEOWNERS / `check_repo_settings.py` | **不做门禁**，只在 PR_GUIDE 里记下命令 | 单人维护，CODEOWNERS 等于自己给自己放行（IdleJot 自己也只在第二个维护者出现时才翻转） |

## 3. 契约

### `scripts/gates.json`

```json
{
  "version": 1,
  "fmtBaseline": 122,
  "shards": [{ "name": "static", "why": "…" }, …],
  "ci":     [{ "name": "…", "cmd": ["node", "scripts/…"], "cwd": "src-tauri", "shard": "static", "why": "…" }],
  "manual": [{ … }],
  "support": []
}
```

- `cmd` 是 **argv 数组**，不经 shell 拼串（Windows 上引号/路径空格是雷）。
- `cwd` 相对仓库根，缺省为根（`cargo test --lib` 要 `src-tauri`）。
- 每条 `ci` 必须带 `shard`；`manual` 不进 CI（真窗口 e2e）。

### `scripts/run-gates.mjs`

```
node scripts/run-gates.mjs ci [--shard <name>] [--fail-fast] [--list]
```

- 片内**串行**（保持 AGENTS 的「安静窗口」纪律），默认片内全跑，`--fail-fast` 才提前收手。
- 有 `GITHUB_STEP_SUMMARY` 时把逐条结果写进 job 摘要。
- 退出码：全绿 0 / 有红 1 / 用法错 2。

### `scripts/check-gates-manifest.mjs`（元门禁）

四者零漂移：**磁盘上的 `scripts/check-*.mjs`** ↔ **`gates.json` 的档位** ↔
**`AGENTS.md` 的门禁生成段** ↔ **`ci.yml` 的 matrix 分片**。

- 磁盘有、清单没有 → 红（新增门禁必须登记）；
- 清单有、磁盘没有 → 红；
- 同一条登记在两个档位 → 红；
- `AGENTS.md` 生成段与清单不一致 → 红（`--write` 重写）；
- `ci.yml` 的 `shard: [...]` 与清单 `shards` 不一致 → 红。

### `scripts/check-fmt-baseline.mjs`（本仓特有的坑）

跑 `cargo fmt --check`，数 `Diff in` 行数，**不得超过** `gates.json` 的 `fmtBaseline`。
少于此值不算红（说明顺手修好了），但要打印出来提醒同步下调基线。

背景：基线里刻意保留约 122 处格式差异，裸跑 `cargo fmt` 会重排整个 crate、污染 diff
（AGENTS 红线 2）。以前这条只能靠人肉 `grep -c`，现在变成门禁。

## 4. 改动清单

| 文件 | 改动 |
|---|---|
| `doc/ISSUE_GUIDE.md`（新） | issue 定位、何时开、标题规范、正文四要素、复现命令与 `needs-repro`、`Closes`/`Refs`、回签、记录三件套、反模式、模板 |
| `doc/PR_GUIDE.md`（新） | PR 定位、关闭方式、拆分与命名（`P+字母` / `P+数字`）、分支、标题与 commit、正文分段、基线验证、门禁改动与独立复核、开 PR 前自查、合并条件、合并后对账与回签、本机推送逃生口（SSH）、模板 |
| `scripts/gates.json`（新） | 门禁清单单一来源 |
| `scripts/run-gates.mjs`（新） | 执行器 |
| `scripts/check-gates-manifest.mjs`（新） | 元门禁（含 `--write`） |
| `scripts/check-fmt-baseline.mjs`（新） | fmt 基线守卫 |
| `scripts/gates.test.mjs`（新） | 上面两个门禁的纯函数单测 |
| `.github/workflows/ci.yml`（新） | `static`/`unit`/`rust` 三分片 + `checks` 汇总 |
| `.githooks/commit-msg` / `.githooks/pre-push`（新） | 文案规范 / 推送前 static 分片 |
| `AGENTS.md` | 新增「迭代流程」「证据与验证纪律」「单一归属目录」；红线 1 改为跑 `npm run gates`；文档索引补齐；门禁生成段 |
| `package.json` | `gates` / `gates:static` / `gates:list` 三个脚本 |
| `vitest.config.ts` | include 增加 `scripts/**/*.test.mjs`（门禁自身要被测到） |

## 5. 测试计划

**脚本单测**（`scripts/gates.test.mjs`，走 vitest）

1. `parseShardMatrix(ciYml)`：能从 `shard: [a, b]` 取出分片；缺失/空数组返回 `[]`。
2. `diffManifest({disk, manifest, agentsSection, ciShards})`：四种漂移各一条用例（多登记、漏登记、重复档位、生成段不一致）。
3. `countFmtDiffs(output)`：只数 `Diff in` 行，不把 `Diff in` 出现在正文里的行算进去。

**变异验证**（逐条打红后 `cp` 回写）

1. 从 `gates.json` 删掉一条 ci 门禁 → 元门禁必须红；
2. `ci.yml` 的 matrix 去掉一个分片 → 元门禁必须红；
3. 把 `countFmtDiffs` 的判据从 `startsWith('Diff in')` 改成 `includes` → 对应用例必须红。

**端到端自检**

- `node scripts/run-gates.mjs --list` 打印分片与顺序；
- `node scripts/run-gates.mjs ci --shard static` 全绿；
- `node scripts/run-gates.mjs ci` 全绿（tsc + vitest + cargo test）；
- 在干净 worktree 里跑一次（证明不依赖开发机私有状态）。

## 6. 风险与回滚

- **新增门禁自己坏了会静默放行** → 元门禁自身有单测 + 变异验证，且它检查的是「四者一致」这种可机器判定的关系。
- **CI 首次跑起来可能因环境差异红**（cargo 冷编、WebView2 缺失）→ 分片里不放 e2e；`rust` 分片只用 `cargo test --lib`（不需要 WebView2 运行时）。
- **pre-push 拖慢推送** → 只跑 static（tsc 约 5s + 两条脚本），`SKIP_GATES=1` 留痕跳过。
- **回滚**：全部是新增文件 + AGENTS/package.json/vitest.config 的少量改动，revert 单个 commit 即可；删掉 `.githooks` 后 `git config core.hooksPath` 需手动复原（文档里写了）。

## 7. 明确不做

- 不做分支保护 / CODEOWNERS 的机器校验（单人维护，命令写进 PR_GUIDE 供将来用）；
- 不做发布门禁（本仓无私有数据）；
- 不引入 Python 工具链；
- 不搬 IdleJot 的 91 条门禁——那是它的领域契约，不是通用流程。
