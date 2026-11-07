/**
 * 键位目录（issue #51 / #61）—— 快捷键字符串与文案的**单一事实来源**。
 *
 * 背景：帮助弹窗与底栏速查曾各写一份键位表。#45 把左手别名上线后，帮助弹窗
 * 改了、底栏还写着旧键，用户会以为别名不存在。这里把「键位 + 全量文案」收在
 * 一处，两个入口只按 id 引用；底栏用可选的 `barLabel` 拿短标签，避免把帮助
 * 弹窗的长句塞进 36px 高的底栏。
 *
 * issue #61：右手键（`6–9`、`0`、`U`、`P`、`Y`、`O`、`M`、`[`、`]`、`\`、`?`、
 * `/`、`←`/`→`、`Ctrl+Y`）全部删除，每个动作只留左手单键/左半区可达键位。
 * 新增/修改键位只改本文件；`src/utils/shortcutCatalog.test.ts` 会核对底栏
 * 引用的 id 与 `keys` 是否与本表逐字一致。
 */
export interface ShortcutItem {
  /** 全局唯一；底栏通过它引用条目，不得另写一份键位字符串。 */
  id: string;
  keys: string;
  label: string;
  /** 底栏速查用的短标签（36px 高、横向预算紧张）；缺省时用 `label`。 */
  barLabel?: string;
  /** 底栏速查的颜色语义（保留 = 绿、淘汰 = 红）。 */
  tone?: 'emerald' | 'rose';
}

export interface ShortcutGroup {
  title: string;
  items: ShortcutItem[];
  /** 占满两列（字段表这类需要横向空间的组）。 */
  wide?: boolean;
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: '浏览',
    items: [
      { id: 'prev', keys: 'A', label: '上一张' },
      { id: 'next', keys: 'D', label: '下一张' },
      { id: 'search', keys: 'Ctrl/⌘ + F', label: '搜索宫格列表' },
      { id: 'select-all', keys: 'Ctrl/⌘ + A', label: '宫格内全选（多选路径）' },
      { id: 'grid-rows', keys: '↑ / ↓', label: '宫格内跨行移动（±当前列数）' },
      { id: 'open-external', keys: 'W', label: '在 Photoshop / 默认程序中打开' },
    ],
  },
  {
    title: '标记',
    items: [
      { id: 'rating', keys: '1 ~ 5', label: '打 1-5 星（再按一次同星取消）', barLabel: '打分' },
      { id: 'clear', keys: 'R', label: '清除星级与标记' },
      { id: 'pick', keys: 'F', label: '标记保留 (Pick)', barLabel: '保留', tone: 'emerald' },
      { id: 'reject', keys: 'X', label: '标记淘汰 (Reject)', barLabel: '淘汰', tone: 'rose' },
      {
        id: 'label-left',
        keys: 'Shift + 1 ~ 5',
        label: '色标：红 / 黄 / 绿 / 蓝 / 紫（依次对应，再按一次取消）',
        barLabel: '色标',
      },
      { id: 'undo', keys: 'Ctrl/⌘ + Z', label: '撤销上一步（最多 50 步，批量算一步）' },
      { id: 'redo', keys: 'Ctrl/⌘ + Shift + Z', label: '重做' },
      { id: 'batch-export', keys: 'Ctrl/⌘ + E', label: '打开批量导出' },
    ],
  },
  {
    title: '视图',
    items: [
      { id: 'compare', keys: 'C', label: '切换单图 / 双图对比' },
      { id: 'before-after', keys: 'T', label: '切换前后对照', barLabel: '前后' },
      { id: 'tone', keys: 'E', label: '打开 / 关闭调色面板' },
      { id: 'zoom-1to1', keys: 'Z', label: '1:1 细节（RAW-only 首次需 6–8 秒，再按回适应）' },
      { id: 'hold-original', keys: 'V（按住）', label: '临时查看原片', barLabel: '看原片' },
      { id: 'help', keys: 'F1', label: '打开 / 关闭快捷键帮助' },
      { id: 'escape', keys: 'Esc', label: '关闭弹窗 / 调色面板，或清空宫格搜索' },
    ],
  },
  {
    title: '对比',
    items: [
      { id: 'base-left', keys: 'Q / B', label: '将左图设为基准' },
      { id: 'base-right', keys: 'Shift + Q', label: '将右图设为新基准' },
      { id: 'base-current', keys: '空格', label: '将当前照片设为基准（再按取消）' },
      { id: 'swap', keys: 'S', label: '左右互换' },
      { id: 'lens-meta', keys: 'G', label: '手动镜头元数据编辑' },
    ],
  },
  {
    title: '筛选语法（宫格搜索框，与上方档位叠加）',
    wide: true,
    items: [
      { id: 'filter-rating', keys: 'rating>=3', label: '星级：= >= <= > <（rating:3 即等于 3 星）' },
      { id: 'filter-flag', keys: 'flag:pick', label: '旗标：pick / reject / none' },
      { id: 'filter-label', keys: 'label:red', label: '色标：red / yellow / green / blue / purple / none' },
      { id: 'filter-name', keys: 'name:DSC0*', label: '文件名（* 任意串、? 单字符；裸词按子串匹配）' },
      { id: 'filter-ext', keys: 'ext:arw', label: '扩展名（组内任一文件命中即可）' },
      { id: 'filter-folder', keys: 'folder:2024', label: '所在目录包含该文本' },
      { id: 'filter-edited', keys: 'edited', label: '有精修成果' },
      { id: 'filter-iso', keys: 'iso>=3200', label: 'ISO' },
      { id: 'filter-aperture', keys: 'aperture>=2.8', label: '光圈（按 f 值比较）' },
      { id: 'filter-shutter', keys: 'shutter<=1/500', label: '快门（按秒比较，更快 = 数值更小）' },
      { id: 'filter-focal', keys: 'focal>=85', label: '焦距（mm）' },
      { id: 'filter-camera', keys: 'camera:sony', label: '机身（厂商或型号包含）' },
      { id: 'filter-lens', keys: 'lens:85mm', label: '镜头型号包含' },
      { id: 'filter-negate', keys: '-flag:reject', label: '任意条件前加 - 取反' },
      { id: 'filter-flag-short', keys: 'picked / rejected / unflagged', label: '旗标简写' },
    ],
  },
];

export const MOUSE_SHORTCUTS: ShortcutItem[] = [
  { id: 'mouse-wheel', keys: '滚轮', label: '以指针为中心缩放' },
  { id: 'mouse-drag', keys: '左键拖拽', label: '平移画面（对比视图下双图联动）' },
  { id: 'mouse-dblclick', keys: '双击', label: '在适应窗口 / 250% 之间切换' },
  {
    id: 'mouse-multi-select',
    keys: 'Ctrl / Shift + 点击',
    label: '宫格多选（Ctrl / ⌘）与从锚点范围选择（Shift）',
  },
];

/**
 * 底栏速查的子集与展示顺序（issue #51）。
 *
 * 36px 高、`md` 以上才显示，右侧还有计数 / 撤销 / 重做 / 外部打开，横向预算
 * 不允许把全量键表铺开。只留「画面上看不到按钮」的打分 / 旗标 / 色标 /
 * 前后对照 / 按住看原片；`A / D`（视口内有箭头按钮）、`C`、`E`（工具栏有
 * 可见按钮，title 带快捷键）交给帮助弹窗与按钮 tooltip。
 */
export const BAR_SHORTCUT_IDS: readonly string[] = [
  'rating',
  'pick',
  'reject',
  'label-left',
  'before-after',
  'hold-original',
];

const SHORTCUT_BY_ID = new Map(
  [...SHORTCUT_GROUPS.flatMap((group) => group.items), ...MOUSE_SHORTCUTS].map(
    (item) => [item.id, item] as const,
  ),
);

/** 按 id 取条目；不存在返回 `undefined`（底栏与用例都会在缺失时显式报错）。 */
export function findShortcut(id: string): ShortcutItem | undefined {
  return SHORTCUT_BY_ID.get(id);
}
