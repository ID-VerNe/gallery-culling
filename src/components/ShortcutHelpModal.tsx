import React, { useMemo, useState } from 'react';
import { Keyboard } from 'lucide-react';
import { Modal } from './Modal';
// 键位表单一归属：帮助弹窗与底栏速查都引用 `src/utils/shortcutCatalog.ts`（issue #51）。
import { MOUSE_SHORTCUTS, SHORTCUT_GROUPS } from '../utils/shortcutCatalog';

interface ShortcutHelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

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
      SHORTCUT_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => matchesShortcut(query, i)) })).filter(
        (g) => g.items.length > 0,
      ),
    [query],
  );
  const mouseFiltered = useMemo(
    () => MOUSE_SHORTCUTS.filter((i) => matchesShortcut(query, i)),
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
          className="focus-ring w-full px-3 py-2 rounded-md bg-background-base border border-border-default text-white text-xs outline-none placeholder:text-white/40"
        />
        <p className="mt-1.5 text-[10px] text-white/50" role="status" aria-live="polite">
          {query.trim()
            ? `匹配 ${total} 项`
            : `共 ${SHORTCUT_GROUPS.reduce((n, g) => n + g.items.length, 0) + MOUSE_SHORTCUTS.length} 项`}
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
                  <dd className="text-[11px] leading-snug text-white/80 text-right">
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
