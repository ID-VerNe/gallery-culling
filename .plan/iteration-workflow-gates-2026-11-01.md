# 迭代流程固化第二段 — 实施方案（2026-11-01）

对应 issue：#8 `[规范] 迭代流程固化第二段：门禁链改动披露闸门 + CI 等价复跑`

参照：IdleJot 的 `scripts/check_gate_change_review.py`（#62 / #107 / #324 三代演进）与
`scripts/check_pr_parity.py`（#61）。

---

## 1. 现状：为什么还要一段

issue #6 / PR #7 已经把「流程落纸 + 门禁清单单一来源」做完（`8933b43`）。剩下的缺口是
**这两条守卫在 #6 里没移植**：

| 缺口 | 证据 | 后果 |
|---|---|---|
| 门禁链改动无披露要求 | `doc/PR_GUIDE.md:99` 是一段散文，没有任何脚本读 diff 与 PR 正文 | 被测方在同一个 PR 里删弱断言，CI 只看到绿色 |
| 「本地绿」不可验证 | `.githooks/pre-push` 在没有 `node_modules` 时**静默**跳过 static | PR 写的「全绿」可能只在本机成立 |
| plan 追评无模板 | `AGENTS.md:12` 要求写，`doc/ISSUE_GUIDE.md` 里没有模板 | 新会话自由发挥 |

## 2. 与 IdleJot 的差异（为什么不能照抄）

| IdleJot | 本仓 | 理由 |
|---|---|---|
| Python + `argparse` + `self_test()` 入口自检 | Node ESM + vitest 单测 | 本仓 `scripts/` 全是 `.mjs`，单测已经在 `scripts/gates.test.mjs` 里跑 |
| parity 要剥 `*_WG_*` 环境变量、私有库路径 | 不剥环境 | 本仓没有私有库开关；本地与 CI 的差异只有 `node_modules` 与 `src-tauri/binaries` |
| parity 里 `npm ci` | 链接调用方的 `node_modules` | 同一份 lockfile 的产物，省一次安装；不含未提交源码 |
| parity 注入 `binaries` | **不注入** | 184MB sidecar 与 CI 的占位文件正好是最易分叉处，依赖它的用例就该红 |
| `APPROVED_AT` 时点边界 | 保留（`2026-11-02`） | #8 自己就是「闸门建立之前」的 PR，否则自我打红 |

## 3. 契约

### `scripts/check-gate-change-review.mjs`

```
node scripts/check-gate-change-review.mjs [--base <ref>] [--body-file <path>] [--gate-changes]
```

- 输入优先级：`--base` > `PR_BASE_SHA`；`--body-file` > `PR_BODY_FILE` > `PR_BODY`。
- 门禁链 `PATTERNS`：`scripts/check-*.mjs`、`scripts/gates.json`、`scripts/run-gates.mjs`、
  `.github/workflows/ci.yml`、`.githooks/*`（`*` 跨 `/`）。
- 判定（纯函数 `judge`）：段缺失 / 漏列 / 缺复核行 / 占位结论 / 结论排在证据前 → 红。
- 无 base 未声明 → SKIP（`rc 0`）；声明了改动却无 base、base 非法、正文文件读不到 → `rc 1`（fail-closed）。
- 时点边界 `APPROVED_AT`：基线提交时间早于上界 → 复核只提示不判红。

### `scripts/check-pr-parity.mjs`

```
node scripts/check-pr-parity.mjs [--ref <sha>] [--shard <name>] [--keep]
```

- `git worktree add --detach <tmp>/pristine <sha>` → 校验该 sha 的清单与执行器 → 链接 `node_modules`
  → 用**该 sha 自己那份** `run-gates.mjs` 跑 `ci [--shard]`。
- 退出码：`0` 绿 / `1` 有门禁红 / `2` 环境问题。
- `--keep` 保留现场；`.githooks/pre-push` 对 `origin..HEAD` 的每个 sha 跑一次，`SKIP_PARITY=1` 跳过。

### 登记

- `check-gate-change-review.mjs` → `ci` 档 `static` 分片（CI 要跑它）。
- `check-pr-parity.mjs` → `support` 档（不进 CI：在 CI job 里是嵌套 worktree）。

## 4. 测试计划

| 层 | 内容 |
|---|---|
| 单测 | `scripts/gates.test.mjs` 覆盖 `gateChain` / `gateSection` / `reviewRecord` / `reviewOrderProblem` / `gateApplies` / `judge` 每一档，`main` 的退出码契约，以及 parity 的 `shardProblem` / `missingInputs` / `resolveRef` |
| 成对夹具 | 每条「坏形态必须红」都配同形「好形态必须绿」（排除型断言没有对照组就是假绿） |
| 变异 | 逐个替换被断言的子串，确认用例转红；`cp` 备份 / `cp` 回写还原（不用 `git checkout --`） |

## 5. 代价与风险

- **PR 正文成了门禁输入**：正文格式改动可能误红。缓解：段内比对大小写与斜杠归一；`Refs` /
  分隔线不作为「实质内容」。
- **`fetch-depth: 0`**：CI 每次拉全历史，checkout 略慢；不这么改 merge-base 不可得，闸门会静默放行。
- **pre-push 变慢**：static + parity（约 10s，链接 `node_modules` 后）。逃生口 `SKIP_PARITY=1`。
- **时点边界是常量**：`APPROVED_AT` 调低会让历史 PR 集体变红，只在明确要回溯时改。
