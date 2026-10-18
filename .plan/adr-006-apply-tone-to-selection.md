# ADR-006：套用调色到选中

- 日期：2026-10-18
- 状态：已采纳
- 相关：报告 `docs/lumen-benchmark-2026-10-18.md` §5.6、FR-07；依赖 ADR-002（写盘合并）
- 参考实现：`lumen-raw/lumen/commands.py:472-478`（`edit.copy` 只复制 look）

## 背景

调色面板只能作用于当前照片。选片交付的典型动作是「同一场景 200 张，先调好一张，再套给
其余 199 张」，此前只能逐张手动拖滑杆。报告把这项列为 S3 的第一项，出口标准是
「200 张套用可取消」。

LUMEN 的语义边界很清楚：`edit.copy` 只复制 look（tone/color/effects/process/lens 开关），
**不复制** crop、mask、retouch —— 每张照片保留自己的构图与局部调整。本项目只有 6 个
全局 tone 参数，边界更简单，但同样必须明确「不碰什么」。

## 决策

### 1. 前端逐张复用 `apply_tone_cmd`，不新增批量命令

报告的建议是加 `batch_apply_tone_cmd(ids, tone)`。没有采纳，理由：

- `apply_tone_cmd` 是「XMP 必写 + 引擎可用时 apply/save」的**唯一写入路径**。批量另起
  一条命令意味着这套语义（尤其是「引擎失败不回滚 XMP」）要再实现一遍，两份实现必然漂移；
- 进度与取消点在前端循环里天然精确，不需要新增 `tone-progress` 事件与
  `cancel_apply_tone_cmd`。现有的 `useTaskProgress` 只服务 scan/export，塞第三种任务
  会污染它的事件归一化；
- 每张一次 IPC 约 1ms，相比写盘（10-50ms）可忽略。真正的瓶颈是 LUMEN 工程落盘，
  那是串行的，批量命令也省不掉。

代价：200 张会发 200 次 IPC。实测这条路径的开销不影响进度条的观感（每张都推进度），
且失败隔离天然按张生效。

### 2. 只复制 6 个 tone 字段

`ToneAdjustments` 就是曝光/高光/阴影/色温/色调/对比度，整对象传给命令。**不夹带**
`rating` / `flag` / `label` —— 这三者的写盘走 `update_rating_flag_cmd`，有各自的合并
队列与撤销命令栈；混进调色写入会让「撤销一次」的语义变得不可解释。

测试直接断言 `Object.keys(tone).sort()` 等于六个字段名，防止未来有人往 tone 对象里
塞选片字段。

### 3. 默认只写 XMP，LUMEN 工程可选

`apply_tone_cmd` 增加 `write_lumen: Option<bool>`：

- `None` / `true`：既有单张保存行为（引擎开启时 apply + save_project）；
- `Some(false)`：只写 XMP，**静默返回**，不产生「引擎未启用」警告。

批量默认 `false`。理由是性能：200 张逐张 `edit.apply + save_project` 可能几分钟。
面板上给一个「同时写入 LUMEN 工程（慢）」复选框，并**常驻说明**关闭时 LUMEN 预览
可能仍显示旧调色 —— 这是真实存在的分歧，不能靠文案含糊过去。

`Some(false)` 必须在引擎可用性检查**之前**返回：否则批量默认模式会为每张照片攒一条
「引擎未启用」，前端汇总时变成 200 条同义提示。

### 4. 源照片从目标集合排除

目标 = 选中 ∩ 当前筛选 − 源。排除同时按 **id** 与**归一化路径**：同一张照片可能在两个
集合里拿到不同写法（`D:\shoot\A.ARW` vs `d:/shoot/a.ARW`），只按 id 排除会漏。

`normalizeFilePath` 只做分隔符统一 + 小写，不做 canonicalize。这里漏判的代价是多写一次
同样的值；误判的代价是把该写的目标跳过 —— 保守取「显然相同才算相同」。

### 5. 失败隔离，但警告按原因聚合

- 单张失败：记 `{name, path, reason}`，继续下一张；error toast（持久）列前 3 条；
- 没有可写路径：计入失败，不占用一次 IPC；
- XMP 成功但引擎失败：**算成功**（互操作底线已达成），警告单独留档；
- 警告用 `Map<reason, count>` 聚合：引擎未启用时 200 张会给出一模一样的警告，
  逐条攒下来只是噪音。

### 6. 成功的目标要清掉 `toneMap` 里的旧编辑

`currentTone` 的优先级是 `toneMap[id]` > `group.tone` > 默认值。目标照片若之前编辑过
但没保存，`toneMap` 里的旧值会**遮蔽**刚写入的磁盘基线 —— 用户切过去看到套用前的
调色，会以为套用失败。

因此批量结束后对**成功**的 id 调 `discardToneEditsFor(ids)`（一次 setState）。失败的目标
不清：磁盘没变，用户的编辑还该留着。

### 7. 不纳入撤销栈（已知边界）

调色写盘没有 `before` 快照，`CullCommand` 的三元组（rating/flag/label）也不包含 tone。
强行接入需要为每张保存 6 个 float 的旧值并扩大命令模型，超出本项范围。

代价：套用调色不可 Ctrl+Z 撤销。面板上的说明与 ADR 都如实记录，不假装可逆。若未来
要做，应当扩展 `CullCommand` 为「字段级补丁」，而不是再开一套撤销栈。

## 测试

- `src/hooks/useToneBatch.test.tsx`（14 例）：目标集合（源不在选中/源在选中/路径大小写/
  只有源/tone 未定义）、失败隔离（中间失败/无路径/XMP 成功引擎失败）、取消与重入、
  `writeLumen` 默认与透传、旧编辑清除（成功才清）。
- `src/components/TonalAdjuster.toneBatch.test.tsx`（7 例）：按钮显示条件（0/1/≥2）、
  复选框透传、进行中禁用、常驻说明。
- `src/App.toneBatch.test.tsx`（4 例）：App 接线（多选后只对非源写盘、字段集合、
  `writeLumen`、进度条与「套用中…」）。

变异验证 5 处：4 处被抓住（路径排除退化、失败中断整批、无条件清编辑、默认值翻转），
1 处等价存活（取消的 `break` 换成 `continue` —— 取消标志不复位，后续每轮都会 continue，
结果与 break 相同）。存活已核实为等价变异，不是测试漏洞。

## 代价与风险

- 200 张默认只写 XMP，LUMEN 预览在引擎开启时可能仍是旧调色。这是**显式选择**：
  面板说明 + 复选框 + ADR 三处一致。用户勾选后才会逐张落工程。
- 不可撤销（见决策 7）。
- 逐张 IPC 在极慢的机器上可能让进度条推进得比写盘还密，但 `TaskProgressBar` 自身
  有节流，不会打爆主线程。
