import React from 'react';
import { Keyboard } from 'lucide-react';
import { Modal } from './Modal';

interface ShortcutHelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ShortcutGroup {
  title: string;
  items: Array<{ keys: string; label: string }>;
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
export const ShortcutHelpModal: React.FC<ShortcutHelpModalProps> = ({
  isOpen,
  onClose,
}) => {
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
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        {GROUPS.map((group) => (
          <section key={group.title}>
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
            {MOUSE_ITEMS.map((item) => (
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
    </Modal>
  );
};
