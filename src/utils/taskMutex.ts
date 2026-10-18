/**
 * FR-09 任务互斥表：**一张表回答「现在能不能开始」**。
 *
 * 此前每个入口自己判断（扫描看 isLoading、导出看 canRun、AI 看 isMasking），
 * 于是出现了「扫描中导出」「导出中重扫」这类竞态：扫描完成回调会把用户在扫描
 * 期间的选择覆盖掉（2026-10-15 e2e 实锤）。把它们收进一张表，入口只问表。
 *
 * 三条设计约束：
 * - **对称**：A 挡 B 必须等价于 B 挡 A。不对称会让两个入口的可用性互相矛盾。
 * - **不自阻**：活动不能阻塞自己，否则任务永远起不来（同一活动的并发由计数
 *   处理，不靠表）。
 * - **只禁真正危险的组合**：缩略图与扫描可并行（一个读 EXIF、一个渲染预览），
 *   但缩略图与导出争磁盘，互斥。
 */

export const ACTIVITIES = [
  'scan',
  'export',
  'render',
  'ai',
  'batch-write',
  'apply-tone',
  'refresh',
  'thumbnail',
] as const;

export type TaskActivity = (typeof ACTIVITIES)[number];

/** 中文标签：原因文案直接用它，绝不把内部 id 露给用户。 */
export const ACTIVITY_LABELS: Record<TaskActivity, string> = {
  scan: '扫描照片',
  export: '导出照片',
  render: '渲染导出',
  ai: 'AI 蒙版',
  'batch-write': '批量写盘',
  'apply-tone': '套用调色',
  refresh: '读取 XMP',
  thumbnail: '生成缩略图',
};

/**
 * 互斥表：`BLOCKED_BY[a]` 里的每一项都表示「a 运行时，那一项不能开始」。
 *
 * 七种长任务彼此互斥，理由分四类：
 * - scan / export 共享取消标志（后端 `scan_cancel` / `export_cancel` 是全局的）；
 * - render / ai / apply-tone 共享 LUMEN 常驻进程的编辑态（session 是单份的）；
 * - batch-write / apply-tone / refresh 改写或读取同一批 XMP 文件
 *   （同时跑会互相覆盖，或读到写了一半的值）；
 * - refresh 还可能与扫描争同一批 sidecar 的 mtime 快照。
 *
 * `thumbnail` 只被 export / render 阻塞：它读的是内嵌预览，与扫描不冲突，
 * 但与导出争磁盘 IO。
 */
export const BLOCKED_BY: Record<TaskActivity, readonly TaskActivity[]> = {
  scan: ['export', 'render', 'ai', 'batch-write', 'apply-tone', 'refresh'],
  export: ['scan', 'render', 'ai', 'batch-write', 'apply-tone', 'refresh', 'thumbnail'],
  render: ['scan', 'export', 'ai', 'batch-write', 'apply-tone', 'refresh', 'thumbnail'],
  ai: ['scan', 'export', 'render', 'batch-write', 'apply-tone', 'refresh'],
  'batch-write': ['scan', 'export', 'render', 'ai', 'apply-tone', 'refresh'],
  'apply-tone': ['scan', 'export', 'render', 'ai', 'batch-write', 'refresh'],
  // 刷新会读、裁决还会写同一批 sidecar：与所有长任务互斥，但与缩略图无冲突
  // （缩略图读的是内嵌预览，两边不碰同一个文件）。
  refresh: ['scan', 'export', 'render', 'ai', 'batch-write', 'apply-tone'],
  thumbnail: ['export', 'render'],
};

/**
 * 当前活跃集合里，有哪些活动挡住了 `activity`。
 *
 * 顺序跟随表定义、天然去重 —— 原因文案的稳定性也依赖这一点。
 * 未知值（类型系统之外的脏数据）被静默忽略：宁可放行也不要把按钮永久变灰。
 */
export function blockersOf(
  activity: TaskActivity,
  active: Iterable<TaskActivity>,
): TaskActivity[] {
  const running = new Set(active);
  return BLOCKED_BY[activity].filter((a) => running.has(a));
}

/**
 * 现在能否开始 `activity`。
 *
 * 两层判定：
 * 1. **自己已经在跑** → 不能开第二份（同一活动的并发由入口的 running 判断挡，
 *    表里刻意不自阻，否则「不自阻」这条结构性质就不成立）；
 * 2. 表里有互斥活动在跑 → 不能开始。
 */
export function canStart(
  activity: TaskActivity,
  active: Iterable<TaskActivity>,
): boolean {
  const running = new Set(active);
  if (running.has(activity)) return false;
  return blockersOf(activity, running).length === 0;
}

/**
 * 禁用原因的**常驻文案**（不是 title：disabled 按钮不可聚焦，读屏拿不到）。
 *
 * 返回 null 表示可以开始，调用方据此决定要不要渲染说明。
 */
export function blockReason(
  activity: TaskActivity,
  active: Iterable<TaskActivity>,
): string | null {
  const running = new Set(active);
  const blockers = blockersOf(activity, running);
  // 自己已在跑时把它排在最前：用户最需要知道的是「这个任务还没结束」。
  if (running.has(activity)) blockers.unshift(activity);
  if (blockers.length === 0) return null;
  const names = blockers.map((a) => ACTIVITY_LABELS[a]).join('、');
  return `正在${names}，暂时不能${ACTIVITY_LABELS[activity]}。`;
}
