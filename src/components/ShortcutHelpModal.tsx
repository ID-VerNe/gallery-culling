import React, { useMemo, useState } from 'react';
import { Keyboard } from 'lucide-react';
import { Modal } from './Modal';

interface ShortcutHelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ShortcutGroup {
  title: string;
  items: Array<{ keys: string; label: string }>;
  /** 占满两列（字段表这类需要横向空间的组）。 */
  wide?: boolean;
}

const GROUPS: ShortcutGroup[] = [
  {
    title: '浏览',
    items: [
      { keys: 'A / ←', label: '上一张' },
      { keys: 'D / →', label: '下一张' },
      { keys: '/', label: '搜索宫格列表' },
      { keys: 'O', label: '在 Photoshop / 默认程序中打开' },
    ],
  },
  {
    title: '标记',
    items: [
      { keys: '1 ~ 5', label: '打 1-5 星（再按一次同星取消）' },
      { keys: '0 / U', label: '清除星级与标记' },
      { keys: 'P', label: '标记保留 (Pick)' },
      { keys: 'X', label: '标记淘汰 (Reject)' },
      { keys: '6 / 7 / 8 / 9', label: '色标：红 / 黄 / 绿 / 蓝（再按一次取消）' },
      { keys: 'Shift + 6', label: '色标：紫' },
      { keys: 'Ctrl/⌘ + Z', label: '撤销上一步（最多 50 步，批量算一步）' },
      { keys: 'Ctrl/⌘ + Shift + Z', label: '重做（Ctrl + Y 亦可）' },
      { keys: 'Ctrl/⌘ + E', label: '打开批量导出' },
    ],
  },
  {
    title: '视图',
    items: [
      { keys: 'C', label: '切换单图 / 双图对比' },
      { keys: 'Y', label: '切换前后对照' },
      { keys: 'E', label: '打开 / 关闭调色面板' },
      { keys: '\\（按住）', label: '临时查看原片' },
    ],
  },
  {
    title: '对比',
    items: [
      { keys: '[ 或 B', label: '将左图设为基准' },
      { keys: '] 或 空格', label: '将右图设为新基准' },
      { keys: 'S', label: '左右互换' },
      { keys: 'M', label: '手动镜头元数据编辑' },
    ],
  },
  {
    title: '筛选语法（宫格搜索框，与上方档位叠加）',
    wide: true,
    items: [
      { keys: 'rating>=3', label: '星级：= >= <= > <（rating:3 即等于 3 星）' },
      { keys: 'flag:pick', label: '旗标：pick / reject / none' },
      { keys: 'label:red', label: '色标：red / yellow / green / blue / purple / none' },
      { keys: 'name:DSC0*', label: '文件名（* 任意串、? 单字符；裸词按子串匹配）' },
      { keys: 'ext:arw', label: '扩展名（组内任一文件命中即可）' },
      { keys: 'folder:2024', label: '所在目录包含该文本' },
      { keys: 'edited', label: '有精修成果' },
      { keys: 'iso>=3200', label: 'ISO' },
      { keys: 'aperture>=2.8', label: '光圈（按 f 值比较）' },
      { keys: 'shutter<=1/500', label: '快门（按秒比较，更快 = 数值更小）' },
      { keys: 'focal>=85', label: '焦距（mm）' },
      { keys: 'camera:sony', label: '机身（厂商或型号包含）' },
      { keys: 'lens:85mm', label: '镜头型号包含' },
      { keys: '-flag:reject', label: '任意条件前加 - 取反' },
      { keys: 'picked / rejected / unflagged', label: '旗标简写' },
    ],
  },
];

const MOUSE_ITEMS: Array<{ keys: string; label: string }> = [
  { keys: '滚轮', label: '以指针为中心缩放' },
  { keys: '左键拖拽', label: '平移画面（对比视图下双图联动）' },
  { keys: '双击', label: '在适应窗口 / 250% 之间切换' },
];

/**
 * The shortcut catalogue used to live as a 6-item strip in the status bar,
 * which is why most of the single-handed workflow was undiscoverable.
 */
/**
 * 快捷键条目是否命中查询。
 *
 * 纯函数，便于单测：中文按 label 匹配，键位按 keys 匹配（大小写与空格不敏感）。
 */
export function matchesShortcut(query: string, item: { keys: string; label: string }): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    item.label.toLowerCase().includes(q) || item.keys.toLowerCase().includes(q)
  );
}

export const ShortcutHelpModal: React.FC<ShortcutHelpModalProps> = ({
  isOpen,
  onClose,
}) => {
  // UX-18：~20 项快捷键原先只能靠扫描。记不住键位的人打开这个弹窗是为了
  // 找「打星是哪个键」，却必须逐行读 —— 加一个按 label/keys 子串过滤的输入框。
  const [query, setQuery] = useState('');
  const filtered = useMemo(
    () =>
      GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => matchesShortcut(query, i)) })).filter(
        (g) => g.items.length > 0,
      ),
    [query],
  );
  const mouseFiltered = useMemo(
    () => MOUSE_ITEMS.filter((i) => matchesShortcut(query, i)),
    [query],
  );
  const total = filtered.reduce((n, g) => n + g.items.length, 0) + mouseFiltered.length;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="键盘与鼠标操作"
      maxWidth="max-w-2xl"
      icon={<Keyboard className="w-4 h-4 text-white/70" aria-hidden="true" />}
      footer={
        <button
          onClick={onClose}
          className="focus-ring px-3.5 py-1.5 rounded-md bg-white hover:bg-white/90 text-black active:scale-[0.96] font-medium transition-transform shadow-sm"
        >
          知道了
        </button>
      }
    >
      <div className="mb-4">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索快捷键，例如「星级」「对比」「撤销」"
          aria-label="搜索快捷键"
          className="focus-ring w-full px-3 py-2 rounded-md bg-background-base border border-default text-white text-xs outline-none placeholder:text-white/40"
        />
        <p className="mt-1.5 text-[10px] text-white/50" role="status" aria-live="polite">
          {query.trim()
            ? `匹配 ${total} 项`
            : `共 ${GROUPS.reduce((n, g) => n + g.items.length, 0) + MOUSE_ITEMS.length} 项`}
        </p>
      </div>

      {total === 0 ? (
        <p className="text-center text-xs text-white/60 py-8">
          没有匹配「{query.trim()}」的快捷键，换个词试试。
        </p>
      ) : (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        {filtered.map((group) => (
          <section key={group.title} className={group.wide ? 'sm:col-span-2' : undefined}>
            <h3 className="text-[11px] font-semibold text-white/60 uppercase tracking-wide mb-2">
              {group.title}
            </h3>
            <dl className="flex flex-col gap-1.5">
              {group.items.map((item) => (
                <div
                  key={item.keys}
                  className="flex items-baseline justify-between gap-3"
                >
                  <dt className="shrink-0">
                    <kbd className="bg-white/10 border border-white/15 px-1.5 py-0.5 rounded text-[10px] font-mono text-white/90 whitespace-nowrap">
                      {item.keys}
                    </kbd>
                  </dt>
                  <dd className="text-[11px] leading-relaxed text-white/80 text-right">
                    {item.label}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}

        <section className="sm:col-span-2">
          <h3 className="text-[11px] font-semibold text-white/60 uppercase tracking-wide mb-2">
            鼠标
          </h3>
          <dl className="flex flex-col gap-1.5 sm:grid sm:grid-cols-3 sm:gap-3">
            {mouseFiltered.map((item) => (
              <div key={item.keys} className="flex items-center gap-2">
                <dt className="shrink-0">
                  <kbd className="bg-white/10 border border-white/15 px-1.5 py-0.5 rounded text-[10px] font-mono text-white/90 whitespace-nowrap">
                    {item.keys}
                  </kbd>
                </dt>
                <dd className="text-[11px] text-white/80">{item.label}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
      )}
    </Modal>
  );
};
