# ADR-005：查询式筛选

- 日期：2026-10-18
- 状态：已采纳
- 相关：报告 `docs/lumen-benchmark-2026-10-18.md` §5.5、FR-06；依赖 ADR-003（色标字段）
- 参考实现：`lumen-raw/lumen/catalog.py:269-336`（`parse_query` / `matches`）

## 背景

升级前，宫格搜索框只做一件事：`baseName.toLowerCase().includes(q)`。想找「ISO≥3200 且
85mm 且未淘汰」只能肉眼翻。报告把这项列为 S2 的第二项，出口标准是「10k 查询 <50ms；
chips 与语法共存」。

LUMEN 已有一套字段语法，纯逻辑、无平台依赖，可以直接移植。本项目多一个条件：
**不能把老用户按文件名搜索的肌肉记忆弄坏** —— 搜索框是他们唯一的搜索入口。

## 决策

### 1. 裸词仍然是文件名子串

`DSC0` 解析成 `{ field: 'name', op: 'contains', value: 'dsc0' }`，不是「未知字段」，
也不是 glob。

这是整条需求最容易做错的一处：如果把裸词当 glob，`DSC0` 会从「包含」变成「完全等于」，
用户的搜索会无声变严，而且没有任何报错提示他。

`name:` 前缀则一律走 glob（无通配符时等价于精确相等）—— 写 `name:DSC0` 的人是在指定
完整文件名，语义本来就不同。

### 2. 解析出错是提示，不是拒绝

`matchesParsedQuery` 在有 `errors` 时**放行全部**。

理由：用户拼错一个字段就整屏清空，比不支持语法更糟。错误只在搜索框下方以 amber 文案
显示，不弹红框、不阻断输入。这也符合报告 R10 的缓解策略「chips 为主、语法为辅」。

**这条宽容不延伸到导出。** 见决策 9。

### 3. 未完成输入不算错

敲到 `iso:` 时值还空着。此时既不该报错（用户还在打字），也不该生效（`iso:` 若按
「等于空」求值会筛掉全部）。放进 `pending`，UI 显示「输入中…」。

### 4. 取反在求值之后统一处理

```ts
for (const term of terms) {
  if (evalTerm(g, term) === term.negated) return false;
}
```

每个字段只实现「正面命中」一种语义，取反自动成立。若在每个字段里各写一份取反，
迟早出现「rating 的取反写对了、flag 的写错了」。

### 5. 枚举用 `=`，文本用 `contains`

`flag:pick` 若用包含语义求值，未来出现 `picked` 这类取值时会误命中。
`label` / `flag` / `ext` 是精确匹配，`name` / `folder` / `camera` / `lens` 是包含。

`label:none` 是「没有色标」的显式写法 —— 空串本身没法写进查询串。

### 6. 数值字段宽容解析，快门统一为秒

EXIF 里存的是带单位的字符串（`f/2.8`、`1/1000`、`85mm`、`6400`），用户也未必照抄格式。
解析时剥掉 `f/`、`mm`、`s` 前缀后缀。

快门换算成秒（`1/500` → 0.002），这样「更快」就是「数值更小」，
`shutter<=1/500` 的直觉才成立。

解析不出数字 → 报错并给示例，不是静默当 0。

### 7. glob 正则缓存

`name:DSC0*` 在 10k 张上会被求值 10k 次。每次 `new RegExp` 是这一层最容易踩的性能坑，
用模块级 `Map<pattern, RegExp>` 缓存。pattern 数量等于词条数，不会增长。

### 8. chips 与语法是 AND，查询落在 `filteredIndices` 层

`filteredGroups`（chips 粗筛）→ `filteredIndices`（语法细筛）。

不把查询并进 `filteredGroups` 的原因：`selectedIndex` 的坐标系是 `filteredGroups`
的下标，`filteredIndices` 负责「可见位置 → 工作集下标」的映射。这个分层是升级前就有的，
查询只是替换了映射里的谓词，坐标系不变 —— 改动面最小，也不会让「切档后当前照片无声
消失」那套救援逻辑失效。

计数保持现状：chips 的 `(N)` 仍是对全量的计数，查询模式下只在搜索框下方显示
「N 个条件 · 匹配 M 张」。报告明确要求不要给每个 chip 都算一遍。

### 9. 导出范围复用查询，但语法错误时归零

报告 §5.5 第 5 点要求合并，否则导出侧会沉淀出第二套筛选逻辑。

新增 `current_query` 档：`g.flag !== 'reject' && !queryInvalid && matchesChips(g) && matchesQuery(g)`。

两处刻意收紧：

- **语法有错时一律不命中**（候选 0 张，走既有的「没有候选」校验拦住导出）。宫格可以
  宽容，导出不能：用户以为筛了 40 张、实际导出 500 张，是不可撤销的错误。
- **仍然排除淘汰**。chips 选「已淘汰」时 `matchesChips` 会命中淘汰，这一档不能因此
  把淘汰放出去 —— 「淘汰永不导出」是既有红线。

`ExportFilterSpec.test` 因此多了 `ctx` 参数（`matchesChips` / `matchesQuery` /
`queryInvalid`），其余档忽略它。

## 明确不做

- **自动补全 / 语法高亮**。报告提到「示例/自动补全」，本轮只做了三个可点击示例
  （`QUERY_EXAMPLES`）与帮助弹窗里的字段表。补全需要维护光标位置与候选列表，收益
  不抵复杂度 —— 语法本身只有十来个字段。
- **`★★★+` 星号简写**。LUMEN 支持，但中文用户更可能输入 `rating>=3`；两个都支持
  会让帮助文案变长。
- **正则查询**。glob 已覆盖常见需求，正则的误用成本太高（一个 `.*` 就能让 10k 张全命中）。
- **查询语法进 URL / 持久化**。进程内状态，重启即空。

## 验收用例索引

`src/utils/queryMatch.test.ts`（33 条）

- 解析：比较符、冒号等于、取反、裸词子串、name glob、枚举归一、布尔字段、EXIF 宽容解析、
  多词条、空串
- 错误与未完成：`iso:` → pending、未知字段带字段表、非数字带示例、枚举非法值带可选值、
  一个词条出错不影响其余
- 匹配：rating 四种比较、flag/label、label:none、name glob 与子串、ext、folder、edited、
  iso/aperture/shutter/focal、camera 双字段、lens、缺 EXIF 不抛错、取反、AND、空词条恒真
- 错误放行：有错误时全部通过
- 性能：10k × 3 词条 <50ms（实测 ~18ms）

`src/App.queryFilter.test.tsx`（9 条）

- 查询真的收窄宫格（rating>=3 / flag:reject / 取反 / 裸词）
- chips 与语法交集（Pick ∧ rating>=3）
- 未知字段、非数字、一半对一半错、`iso:` 四种错误态都不清空宫格

`src/hooks/useExportForm.test.ts`（+5 条）

- 无查询时等价于全部非淘汰
- 叠加语法后收窄且仍排除淘汰
- chips ∧ 语法
- 语法有错时归零
- 计数与候选同源

## 变异验证

| # | 变异 | 结果 |
|---|---|---|
| 1 | 取反失效（`=== negated` 改成 `!evalTerm`） | 抓到 |
| 2 | AND 变恒真（`return false` 改成 `continue`） | 抓到 |
| 3 | glob 退化成子串 | 抓到 |
| 4 | 光圈单位解析失效 | 抓到 |
| 5 | 未知字段静默忽略 | 抓到 |
| 6 | 语法出错时清空宫格 | 抓到 |
| 7 | 导出忽略 chips | 抓到 |
| 8 | 导出语法错误时放行 | 抓到 |
| 9 | 有错误时短路掉放行分支 | **存活（等价变异）** |

第 6 条第一次跑是**存活**的：`filteredIndices` 在 `terms.length === 0` 时短路，
`ratng:3` 这类「有错误、无有效词条」的输入根本走不到 `matchesParsedQuery` 的错误分支。
修掉短路条件后被抓。第 9 条是它的对照：短路与否行为等价，所以存活是预期的 ——
保留非短路写法只是为了让那条分支不至于变成死代码。
