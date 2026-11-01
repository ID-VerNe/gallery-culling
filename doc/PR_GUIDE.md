# 怎么开 PR（PR 操作指引）

> 本文件是仓库内所有 Agent 与协作者的 PR 规范，**必须遵照执行**。
> 配套：怎么发 issue 见 [ISSUE_GUIDE.md](ISSUE_GUIDE.md)；流程总览见 [AGENTS.md](../AGENTS.md) §「迭代流程」。

## 定位：PR 是最小可审查单元

- 一 issue 一 PR：PR 是 issue 的实施载体。**合并只代表改动进了 `master`，不代表症状消失**——行为类 PR 用 `Refs #NN`，issue 由发现者回签后关闭。合并前的审批由全新上下文的 subagent 做（见「合并评审」），不需要维护者逐 PR 人工过目。
- 拆分原则：每个 PR 都能独立通过门禁、独立合并、独立回滚；拆不开说明边界没想清，回 issue 补 plan。
- 大 issue 先拆再派：**分节用 `P+字母`，优先级用 `P+数字`**。

## 关闭方式：Closes 还是 Refs

| 关键词 | 适用 PR | 关闭时机 |
|---|---|---|
| `Closes #NN` | 纯文档（`doc/`、`docs/`、`.plan/`、`*.md`）、纯重构（不改外部行为） | 合并即关闭 |
| `Refs #NN` | 行为类：`fix` / `feat` / `perf`，以及任何触及运行时代码路径的 PR | 合并只进待验收队列（`needs-live-verify`），回签后才关闭 |

判据一句话：**合并后是否还需要在真实应用里再观察一次症状才能确认有效**——需要就是行为类。

- 同一 PR 既改文档又改行为：按行为类走。
- 多分节 issue 的每个 PR 都用 `Refs #NN`，全部分节合并后统一回签、一次关闭。

## 拆分与命名规范

| 维度 | 标识 | 语义 | 回答的问题 |
|---|---|---|---|
| 分节（步骤） | `P+字母`：`PA`/`PB`…`PZ` | 把 issue 切成有序、可独立合并的步骤；**一个分节 = 一个 PR** | 这是大 issue 的哪一步 |
| 优先级 | `P+数字`：`P0`/`P1`/`P2` | 严重度：P0 阻断（数据损坏 / 导出错误 / 主链不通）、P1 常见路径、P2 边角与增强 | 先做哪个 |

- 正交使用：先按优先级定顺序，同优先级内按分节字母序推进。
- 分节编号 issue 内全局唯一、按序分配、不随优先级重置；分节内多项用 `P+字母+数字`（`PE4`）。
- 引用格式：`#<issue>-P<字母>[数字]`，如 `#6-PA`。

落点全覆盖：

| 位置 | 形态 |
|---|---|
| issue 正文分节标题 | `### PA · <标题>（P1）` |
| 分支 | 多分节 `type/<issue>-p<字母>[-<数字>]-<slug>`；单分节 `type/<issue>-<slug>` |
| PR 标题 / commit | `type(scope): 摘要（issue #NN）`；多分节加「分节 PA」后缀 |

命名反模式：裸字母分节（A/B/C、「阶段一」）、`P0-R1` 式混合编号、分节编号随优先级重置、把优先级当步骤用。

## 分支

```
type/<issue 号>-<slug>                     # 如 feat/4-lens-presets、docs/6-iteration-workflow
type/<issue 号>-p<字母>-<slug>             # 多分节，如 feat/6-pb-gates-runner
```

- 从最新 `master` 切，**用 git worktree，不在主工作区切分支**：

  ```bash
  git worktree add ../gallery-flask-<issue> -b type/<issue>-<slug> master
  ```

- `type` 与 issue 的 type 对齐（`fix` / `feat` / `docs` / `refactor` / `chore` / `test`）。
- worktree 里没有 `node_modules` / `src-tauri/binaries`（都被 gitignore）：
  - `npm ci` 装依赖；
  - `src-tauri/binaries/` 是 184MB 的 sidecar，用**目录联接**共享，别复制：
    `New-Item -ItemType Junction -Path <wt>/src-tauri/binaries -Target <main>/src-tauri/binaries`；
  - **删 worktree 前先拆联接**（`(Get-Item <wt>/src-tauri/binaries -Force).Delete()`），否则有连带删除源目录的风险。
- worktree 用完 `git worktree remove --force <path>`，别留在磁盘上发酵。

## 标题与 commit

- PR 标题：`type(scope): 摘要（issue #NN）`——**分支、标题、commit 三处都带 issue 号**，grep 任一入口都能回到 issue。
- commit 正文说清**为什么这么改**与实测数字，不要只列改了哪些文件。
- 一个 PR 允许多个 commit，但每个 commit 自解释，别写 `wip` / `fix`。
- **禁止 `Co-Authored-By:` 行**（`.githooks/commit-msg` 会拦）。
- 逐个 `git add <file>`，禁止 `git add .` / `-A` / 目录批量。

## 正文分段

固定结构，**必填段缺一不可**：

| 段 | 必填 | 内容 |
|---|---|---|
| `Closes #NN` / `Refs #NN` | 是 | 按上节二选一，放正文开头或末尾 |
| `## 问题` | 是 | 复述 issue 的现象 + 根因（带 `文件:行号`） |
| `## 改动` | 是 | 按文件列改动，每个文件说清「为什么」；新门禁注明登记进 `scripts/gates.json` 的哪个档位 |
| `## 测试` / `## 验证` | 是 | 贴门禁原始输出（`node scripts/run-gates.mjs ci` 的逐条结果与 PASS 行）；只写「都过了」不算 |
| `## 基线验证` | 修红门禁 / 修误报时必填 | 见下 |
| `## 门禁改动` | diff 触及门禁链时必填 | 见「门禁改动与独立复核」 |
| `## 影响面` | 是 | 行为变化、兼容性、明确不动的部分 |
| `## 验收对照` | 大 issue 拆分时必填 | 按分节逐条对照，未完成项显式列出并转新 issue |

### 基线验证是硬要求

修「门禁误报 / 测试自身缺陷」类 issue 时，必须证明回归真的钉住了缺陷：

- 同一用例在**未打补丁的 base**（pristine worktree）上必须红，且红的签名与 issue 症状一致；
- 打补丁后转绿；
- 两者输出都贴进 PR。只有「打了补丁就绿」没有「不打补丁就红」= 假绿，不予合并。

### 门禁改动与独立复核

门禁是这套协作里唯一的第三方校验，**被测方却可以在同一个 PR 里改门禁**。所以 diff 触及门禁执行链时，验收标准加两条——触发范围（任一命中）：`scripts/check-*.mjs`、`scripts/gates.json`、`scripts/run-gates.mjs`、`.github/workflows/ci.yml`、`.githooks/` 下全部钩子。

1. **正文必须有 `## 门禁改动` 段**，逐个文件交代：断言改了什么（改前/改后）、为什么必须改（原始症状如何要求这条改动，不能是「为了变绿」）、三种组合的红绿证据（未打补丁 base / 打补丁 / 只改门禁——**只改门禁必须仍红在原症状上**）、是否同步改了清单与 `AGENTS.md` 生成段。
2. **独立复核**：由**不同上下文**的复核会话只读 PR diff + 本地复跑门禁，结论（`APPROVE` / `REQUEST_CHANGES`）与证据写进 `## 门禁改动` 段**末尾**。修复者不能给自己复核。

清单至少覆盖：门禁是否仍能钉住原症状（而不是改成「怎么跑都绿」）；是否删弱或跳过了断言、放宽了阈值；基线是否真红；是否漏改清单 / 生成段 / `ci.yml`。

**这两条是机器门禁**（`scripts/check-gate-change-review.mjs`，registry 见 `scripts/gates.json` 的 `static` 档）——不再靠人眼：

- CI 在 PR 上读 `base...HEAD` 改动集与正文：命中门禁链却没有段、段内漏列文件、段末没有复核结论、或复核结论排在证据之前（**自审形状**）→ 红。
- 结论只认 `APPROVE` / `APPROVED` / `REQUEST_CHANGES`；`<PENDING>` 与空白不算复核。`REQUEST_CHANGES` 本身**能通过**这条门禁——它校验的是「结论已贴且顺序正确」，结论内容由评审人判断。
- 红灯的语义是「复核还没贴」，不是「CI 坏了」：作者补完结论后重跑即绿。
- 生效边界：`APPROVED_AT`（`2026-11-02`）之前开的 PR 只提示不判红。

本机先自查一遍（推送前就能发现漏列）：

```bash
node scripts/check-gate-change-review.mjs --base origin/master --body-file pr.md
```

### CI 等价复跑（parity）

「本地绿」与「CI 绿」不是同一件事：worktree 里有 `node_modules`，主工作区还有被 gitignore 的 `src-tauri/binaries`（184MB sidecar，CI 只造 1 个占位文件）。PR 里写的「全绿」如果只在开发机成立，到 CI 才翻红——那时归因成本已经很高。

```bash
node scripts/check-pr-parity.mjs --shard static   # 快速：只跑最便宜的一档
node scripts/check-pr-parity.mjs                  # 全量三片
```

它把复跑挪到**被推送 sha 的临时 detached worktree**（只有已跟踪文件），用该 sha 自己的 `run-gates.mjs` + `gates.json` 执行；`node_modules` 链接进来（同一份 lockfile 的产物），`src-tauri/binaries` **不注入**（正是与 CI 分叉处，依赖它的用例就该在这里红）。退出码：`0` 绿 / `1` 有门禁红 / `2` 环境问题（ref 解析不了、worktree 建不起、未知分片）。

`.githooks/pre-push` 对每个被推送的 sha 自动跑一次（static 片）；`SKIP_PARITY=1 git push` 跳过并留痕。

## 开 PR 前自查

1. `npm run gates`（= `node scripts/run-gates.mjs ci`）全绿；只改文档时可只跑 `npm run gates:static`，但 PR 里要说明。
2. **本机红线先跑基线**：门禁红了先判断是代码问题还是环境问题——用 `git worktree` 开一个 pristine HEAD 对照跑一遍，同族失败就是既有环境抖动（已知：满负荷下 App 级集成用例会 5s 超时假红，master 基线同条件也能复现），记录在案，不要盲目「修复」。
3. 确认分支基于最新 `master`：`git fetch origin master` 后无落后。
4. 门禁链改动先自查：`node scripts/check-gate-change-review.mjs --base origin/master --body-file pr.md`——它会直接告出漏列哪个文件。
5. 做过 CI 等价复跑：`node scripts/check-pr-parity.mjs --shard static`（pre-push 也会自动跑），PR 的「测试」段贴它的 PASS 行。

## 合并条件（全部满足才合）

1. **CI 全绿**：`checks` 汇总 job 通过（三个分片任一红即失败）。
2. **无冲突**：GitHub 显示 `MERGEABLE` / `CLEAN`；有冲突不强行合——在 worktree 里 `git merge origin/master` 解决，重跑门禁后再推。
3. 适用时有 `## 基线验证` 段。
4. **合并评审结论为 `APPROVE`**：由全新上下文的 subagent 出具，见下节。提交者不需要（也不应该）等维护者人工点头。

合并方式跟随仓库现状：**merge commit**（`gh pr merge <n> --merge`），不 squash、不 rebase。远端 commit sha 与本地对不上是正常的（GitHub 可能重签），核对内容以 **tree sha** 为准。

### 合并评审

提交者写完全部文档、CI 转绿之后，**开辟一个全新上下文的 subagent 做合并评审**，由它决定合不合；维护者不再逐 PR 人工确认。

**派发要求**（提交者负责把这些写进评审 task）：

- 评审者必须是**全新上下文**，且不是本 PR 的作者会话；只给它 PR 编号、仓库路径和本节，**不投喂提交者的结论或辩解**。
- 评审者的结论是唯一合并依据：`APPROVE` → 提交者直接合并；`REQUEST_CHANGES` → 按意见改，改完重新派一轮全新上下文的评审。

**评审要做的**（默认怀疑，只信自己跑出来的东西）：

1. 通读 diff，核对 PR 正文的每一句「已经做了什么」是否真的落在磁盘上——「完成声明以磁盘为准」。
2. 在 PR 分支的 worktree 里**自己复跑** `npm run gates`，以及适用时的 `node scripts/check-pr-parity.mjs --shard static`，贴原始输出，不采信 PR 里转述的绿。
3. 行为类 PR：核对验收是否真的覆盖 issue 的复现路径；改了门禁链的，按「门禁改动与独立复核」清单逐条查（是否弱化断言、放宽阈值、基线是否真红）。
4. 核对分段齐全、`Closes` / `Refs` 用对、分支 / 标题 / commit 三处都带 issue 号。
5. 结论写进 PR 评论：`APPROVE` 或 `REQUEST_CHANGES`，后附证据（门禁原始输出、文件行号）。**没有证据的结论无效。**

评审通过后由提交者合并，完成「合并后：对账与回签」的自查部分，再另派一个全新上下文的会话做回签。

> **本机 `git push` 不通时**：`https://github.com` 走代理会返回 `CONNECT tunnel failed 502`，但 **SSH 与 `api.github.com` 都通**。用
> `git push git@github.com:ID-VerNe/gallery-culling.git <branch>`，`gh` 命令照常可用。

## 合并后：对账与回签

对账是修复者自查，回签是发现者验收，两者都要做：

- **自述 vs 实际逐项核对（修复者）**：PR 说做了的每一条，合并后独立复核（`git status`、文件存在性、门禁原始输出）。「完成声明以磁盘为准」，不采信任何转述。
- **欠账转新 issue**：对账发现的缺口逐条开新 issue 跟进。合并不算完，对账才算。
- **行为类 issue 回签（发现者 / 全新上下文验证会话）**：修复者合并后给 issue 贴 `needs-live-verify`；回签者按下表贴评论，结论为「症状消失」才摘标签并关闭。仍复现则摘标签、留 issue 并补证据。**回签者不能是本次 PR 的作者。**
- 同根因复发时开第二代修复并互相引用，每代都留能红的用例作墓碑。

### 回签模板

贴到 issue 评论里，字段缺一不可：

- **环境**：`master` @ `<sha>`，本地实机 / CI，`<时间>`
- **复现命令**：优先原样复用 issue「现象」段里的那条
- **期望输出**：修复后应看到什么
- **实际输出**：粘贴原始输出，不要只写「正常」
- **实机证据**：截图路径 / 日志行 / 门禁输出
- **结论**：症状消失 / 仍复现（仍复现要贴差异）

## 模板（可直接抄）

```markdown
## 问题

<issue 现象复述 + 根因，带 `文件:行号`>

## 改动

`<文件>`
- <改动点 + 为什么>

## 测试

```
<node scripts/run-gates.mjs ci 的逐条结果与 PASS 行>
```

## 基线验证

未打补丁 base：<红的签名，与 issue 症状一致>
打补丁后：<绿>

## 门禁改动

仅当 diff 触及门禁链时保留；逐个文件写清改了什么、为什么必须改、三种组合的红绿证据。

**独立复核**：<APPROVE / REQUEST_CHANGES> + 复核证据（必须放在本段最末）

## 影响面

<行为变化 / 兼容性 / 不动的部分>

## 验收对照

- [x] <issue 验收项 1>
- [ ] <未完成项，转 #NN>

Closes #NN
```

行为类 PR 把末行换成 `Refs #NN`，合并后按「合并后：对账与回签」等发现者回签。
