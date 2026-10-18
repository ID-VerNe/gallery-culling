/**
 * FR-10：选片集的入口与报告。
 *
 * 为什么是一个弹窗而不是顶栏两个按钮：
 * - 打开选片集的结果里**必须能列出缺失的文件**（验收标准），toast 会自己消失，
 *   列不出来；
 * - 「存为」与「打开」各自还要弹系统文件对话框，两个顶栏按钮换两次点击却没多
 *   一点信息；
 * - 顶栏右侧已经挤了 7 个控件，再加两个会把「读 XMP」这类低频入口挤到折行。
 *
 * 保存范围**写在按钮上**（「存为选片集（选中 5 张）」），不让用户猜这次存的是
 * 选中还是筛选 —— 存错范围的选片集要重新选一遍才知道。
 */
import React from 'react';
import { FolderPlus, FolderOpen, AlertTriangle, BookMarked } from 'lucide-react';
import { Modal } from './Modal';
import type { AlbumOpenResult } from '../types';

export type AlbumSaveScope = 'selected' | 'filtered';

interface AlbumDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** 当前集合总张数（已扫描 / 已打开）。 */
  totalCount: number;
  /** 当前筛选后的张数。 */
  filteredCount: number;
  /** 当前多选的张数（0 = 没有多选）。 */
  selectedCount: number;
  /** 保存范围：有多选时是 `selected`，否则是 `filtered`。 */
  saveScope: AlbumSaveScope;
  /** 当前集合来自哪个选片集（null = 不是）。 */
  albumPath: string | null;
  saving: boolean;
  opening: boolean;
  /** 上一次打开的缺失报告（null = 没有）。 */
  report: AlbumOpenResult | null;
  onSave: () => void;
  onOpen: () => void;
  onDismissReport: () => void;
}

function baseNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** 缺失项展示用的路径：相对路径原样（它是文件里记的），绝对路径取末两段。 */
function shortSource(source: string): string {
  if (!/^[a-zA-Z]:[\\/]|^\//.test(source)) return source;
  const parts = source.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/');
}

export const AlbumDialog: React.FC<AlbumDialogProps> = ({
  isOpen,
  onClose,
  totalCount,
  filteredCount,
  selectedCount,
  saveScope,
  albumPath,
  saving,
  opening,
  report,
  onSave,
  onOpen,
  onDismissReport,
}) => {
  const saveCount = saveScope === 'selected' ? selectedCount : filteredCount;
  const canSave = saveCount > 0 && !saving && !opening;
  const busy = saving || opening;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="选片集"
      subtitle="把「这批照片是哪些」记成一份清单：可以跨目录，换台机器也能打开。"
      icon={<BookMarked className="w-4 h-4" aria-hidden="true" />}
      maxWidth="max-w-xl"
      disableClose={busy}
      footer={
        <button
          onClick={onClose}
          className="focus-ring px-3 py-1.5 text-white/80 hover:text-white bg-background-surface-hover hover:bg-white/10 rounded-md text-sm"
        >
          关闭
        </button>
      }
    >
      <div className="space-y-4 text-sm text-white/80">
        {/* 当前集合 */}
        <div className="flex items-center gap-2 flex-wrap text-[12px] text-white/60">
          <span>已加载 {totalCount} 张</span>
          <span aria-hidden="true">·</span>
          <span>当前筛选 {filteredCount} 张</span>
          {selectedCount > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-white/85">选中 {selectedCount} 张</span>
            </>
          )}
          {albumPath && (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-white/85" title={albumPath}>
                来自选片集 {baseNameOf(albumPath)}
              </span>
            </>
          )}
        </div>

        {/* 两个动作 */}
        <div className="flex items-start gap-2 flex-wrap">
          <div className="flex-1 min-w-[14rem] space-y-1">
            <button
              onClick={onSave}
              disabled={!canSave}
              className="focus-ring w-full flex items-center gap-2 px-3 py-2 bg-white text-black hover:bg-white/90 disabled:bg-white/10 disabled:text-white/40 disabled:cursor-not-allowed rounded-md font-medium active:scale-[0.99] transition-transform"
              aria-label={`存为选片集，共 ${saveCount} 张`}
            >
              <FolderPlus className="w-4 h-4" aria-hidden="true" />
              <span>
                {saving ? '保存中…' : `存为选片集（${saveScope === 'selected' ? '选中' : '当前筛选'} ${saveCount} 张）`}
              </span>
            </button>
            <p className="text-[11px] leading-snug text-white/50">
              只记路径与当前标记，不复制照片。评级/旗标以磁盘为准，打开时以 XMP 为真值。
            </p>
          </div>

          <div className="flex-1 min-w-[14rem] space-y-1">
            <button
              onClick={onOpen}
              disabled={busy}
              className="focus-ring w-full flex items-center gap-2 px-3 py-2 bg-background-surface-hover hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-md font-medium active:scale-[0.99] transition-colors"
              aria-label="打开选片集"
            >
              <FolderOpen className="w-4 h-4" aria-hidden="true" />
              <span>{opening ? '打开中…' : '打开选片集…'}</span>
            </button>
            <p className="text-[11px] leading-snug text-white/50">
              会替换当前照片列表。找不到的文件不会被跳过，会列在下面。
            </p>
          </div>
        </div>

        {/* 没有可保存的照片：把原因写出来，而不是只给一个灰按钮 */}
        {saveCount === 0 && (
          <p role="status" className="text-[11px] text-amber-200/90">
            {totalCount === 0
              ? '还没有加载照片。先扫描一个目录，或打开一个选片集。'
              : '当前筛选下没有照片，没有可保存的内容。'}
          </p>
        )}

        {/* 缺失报告 */}
        {report && (
          <section
            aria-label="缺失文件报告"
            className="rounded-md border border-amber-400/30 bg-amber-400/5 px-3 py-2 space-y-2"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle
                className="w-4 h-4 text-amber-300 shrink-0 mt-0.5"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="text-[12px] text-amber-100">
                  {report.missing} 张找不到（其余 {report.entries.length - report.missing} 张已载入）
                </p>
                <p className="text-[11px] text-white/50 leading-snug">
                  照片可能被移动或删除了。它们没有被从选片集里删掉 —— 把文件放回原位再打开即可。
                </p>
              </div>
              <button
                onClick={onDismissReport}
                className="focus-ring ml-auto text-[11px] text-white/50 hover:text-white underline shrink-0"
              >
                收起
              </button>
            </div>

            <ul className="max-h-40 overflow-y-auto space-y-1 pr-1">
              {report.entries
                .filter((e) => !e.exists)
                .map((e) => (
                  <li
                    key={e.path}
                    className="flex items-baseline gap-2 text-[11px] font-mono text-white/70"
                  >
                    <span className="truncate" title={e.path}>
                      {shortSource(e.source)}
                    </span>
                    {e.rating > 0 || e.flag !== 'none' ? (
                      <span className="text-white/35 shrink-0">
                        原 {e.rating}★{e.flag === 'pick' ? ' 保留' : e.flag === 'reject' ? ' 淘汰' : ''}
                      </span>
                    ) : null}
                  </li>
                ))}
            </ul>
          </section>
        )}
      </div>
    </Modal>
  );
};
