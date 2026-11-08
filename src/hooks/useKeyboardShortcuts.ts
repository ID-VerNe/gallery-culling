import { useEffect, useRef } from 'react';
import type { ColorLabel } from '../types';

/**
 * 左手色标（issue #61）：`Shift+1…5` = 红 / 黄 / 绿 / 蓝 / 紫。
 *
 * 必须按物理键位 `e.code` 判定：美式布局下 `Shift+1` 的 `e.key` 是 `!`、
 * `Shift+5` 是 `%`，按字符匹配永远落空。
 * 右手 `6`–`9` / `Shift+6` 已随 issue #61 删除，色标只剩左手这一路。
 */
const LABEL_BY_DIGIT_CODE: Record<string, ColorLabel> = {
  Digit1: 'Red',
  Digit2: 'Yellow',
  Digit3: 'Green',
  Digit4: 'Blue',
  Digit5: 'Purple',
};

interface KeyboardShortcutsProps {
  onPrev: () => void;
  onNext: () => void;
  onRate: (rating: number) => void;
  onFlag: (flag: 'pick' | 'reject' | 'none') => void;
  /**
   * 五色色标：`Shift+1…5` = 红/黄/绿/蓝/紫（issue #61，右手 6–9 已删除）。
   * 重复按同一个色标由宿主实现为"取消"。
   */
  onLabel?: (label: ColorLabel) => void;
  /**
   * B2：清除评级与旗标（绑定左手 `R`）。
   *
   * 提供时走这一个回调（宿主把"清零 + 清旗标"合并成**单次写盘**，避免两次 IPC
   * 各写一遍 XMP 造成闪烁与两次磁盘写入）；未提供时退回旧的 `onRate(0)` +
   * `onFlag('none')` 两次调用，保证独立使用本 hook 的调用方向后兼容。
   */
  onClear?: () => void;
  onOpenExternal: () => void;
  onToggleCompare: () => void;
  onSwapCompare?: () => void;
  onTogglePinReference?: () => void;
  onPinLeft?: () => void;
  onPinRight?: () => void;
  /**
   * 空格：把当前照片设为对比基准，已钉住则取消（落在 currentGroup，不落在右窗格）。
   *
   * 返回 `false` 表示 pin 实际没有生效（如无 currentGroup 时是 no-op），
   * 用于决定要不要给反馈；返回 `true` 或历史的 `void` 视为已生效（issue #35）。
   */
  onTogglePinCurrent?: () => boolean | void;
  /**
   * 空格生效后的可感知反馈（SH-03，issue #32）。
   *
   * 焦点停在按钮/链接/`role=option` 上时过去是静默 return，用户看不出空格
   * 做了什么。宿主传入后（App 用 `toast.info`），每次触发都播报一句。
   * 保持可选：独立使用本 hook 的调用方不接也能正常工作。
   */
  onNotify?: (message: string) => void;
  onOpenMetadataModal?: () => void;
  onToggleBeforeAfter?: () => void;
  onToggleTonalPanel?: () => void;
  /**
   * 1:1 细节开关（FR-05），绑定 `Z`。
   *
   * 只做键位映射，真正的缩放状态在视口里（`oneToOneRef` 通道）。放在
   * switch 里而不是前面的组合键分支 —— `Ctrl+Z` / `Ctrl+Shift+Z` 已经在
   * 更早的位置 return，这里天然只收「无修饰键的 z」。
   */
  onToggleOneToOne?: () => void;
  onHoldOriginalStart?: () => void;
  onHoldOriginalEnd?: () => void;
  onFocusSearch?: () => void;
  onOpenShortcutHelp?: () => void;
  /**
   * 打开批量导出弹窗，绑定 `Ctrl/Cmd+E`。
   *
   * 必须单独开一档（放在通用守卫之后、组合键让路之前）：步骤 6 会把所有
   * 带修饰键的按键直接 return，晚一步就永远收不到。
   */
  onOpenExport?: () => void;
  /**
   * 多步撤销（FR-04），绑定 `Ctrl/Cmd+Z`。
   *
   * 位置很关键：本分支排在**通用守卫之后**，所以焦点在输入框/文本域内时
   * `Ctrl+Z` 仍是原生「撤销输入」，不会被照片撤销抢走。
   */
  onUndo?: () => void;
  /**
   * 重做（FR-04），绑定 `Ctrl/Cmd+Shift+Z`。
   *
   * issue #61 删除了 `Ctrl+Y`：`Y` 在键盘右半区，不属于左手可达入口。
   */
  onRedo?: () => void;
}

export function useKeyboardShortcuts({
  onPrev,
  onNext,
  onRate,
  onFlag,
  onLabel,
  onClear,
  onOpenExternal,
  onToggleCompare,
  onSwapCompare,
  onTogglePinReference,
  onPinLeft,
  onPinRight,
  onTogglePinCurrent,
  onNotify,
  onOpenMetadataModal,
  onToggleBeforeAfter,
  onToggleTonalPanel,
  onToggleOneToOne,
  onHoldOriginalStart,
  onHoldOriginalEnd,
  onFocusSearch,
  onOpenShortcutHelp,
  onOpenExport,
  onUndo,
  onRedo,
}: KeyboardShortcutsProps) {
  /** `V` 是否处于按住态 —— 供 blur / visibilitychange 复位兜底判断，避免误复位。 */
  const holdActiveRef = useRef(false);

  useEffect(() => {
    /**
     * True when a modal dialog owns the screen.
     *
     * Without this, the global single-handed shortcuts keep firing on the
     * photo behind the scrim while the export / settings / metadata dialog is
     * open — e.g. pressing `3` with a radio focused rates an invisible photo
     * and desyncs the modal's live count (F-05).
     */
    const isDialogOpen = () =>
      document.querySelector('[role="dialog"][aria-modal="true"]') !== null;

    /**
     * 通用守卫：**任意** INPUT（含 range/checkbox/radio，不得按 type 过滤）+
     * TEXTAREA + contentEditable + SELECT。
     *
     * 唯一命名（勿改名为 isValueOrText）。**绝不加入 `[role="listbox"]`**：项目
     * 唯一的 listbox 是缩略图宫格，其全局单键（`A`/`D`、`F`/`X` 等）都依赖本
     * handler；只有三个基准键例外 —— 见 `isFocusInsideGrid`（issue #95 · PB-2）。
     */
    const isFormControlOrEditing = (el: Element | null): boolean =>
      !!el &&
      (el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA' ||
        (el as HTMLElement).isContentEditable ||
        el.tagName === 'SELECT');

    /**
     * issue #95 · PB-2：焦点是否落在宫格 listbox 内。
     *
     * 宫格只画 `pinnedId` 角标、不展示对比结果，此时改基准用户看不见效果，
     * 切回单图/对比才发现基准被静默钉住。因此三个基准键在宫格内让路。
     *
     * 判定读**真实焦点**（`document.activeElement` 的 listbox 祖先 —— 项目
     * 唯一的 listbox 就是宫格，`ThumbnailGrid.tsx` 的容器与 `role="option"`
     * 都可聚焦），不用「宫格是否可见」这类间接信号；焦点离开即恢复。
     */
    const isFocusInsideGrid = (): boolean => {
      const active = document.activeElement;
      return !!active && active.closest('[role="listbox"]') !== null;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // 1 模态对话框独占屏幕时，任何单键快捷键都失效（防止误改背后的照片）。
      if (isDialogOpen()) return;

      // 2 中文 IME 合成期（拼音上屏）不得触发快捷键。
      if (e.isComposing || e.keyCode === 229) return;

      const el = e.target as Element | null;

      // 3 `V` 按住查看原片：**必须早于通用守卫**，否则 range/宫格聚焦时无法触发。
      //   文本/表单控件内让位，避免抢 `Ctrl+V` 粘贴或 SELECT 的首字母跳转。
      //
      //   issue #61：右手的 `\` 已删除，按住键只剩左手 `V`。
      const isHoldOriginalKey =
        (e.key === 'v' || e.key === 'V') && !e.ctrlKey && !e.metaKey && !e.altKey;
      if (isHoldOriginalKey) {
        if (isFormControlOrEditing(el)) return;
        if (!e.repeat && onHoldOriginalStart) {
          e.preventDefault();
          holdActiveRef.current = true;
          onHoldOriginalStart();
        }
        return;
      }

      // 4 值/文本控件（任意 INPUT / TEXTAREA / contentEditable / SELECT）不劫持单键。
      //   这是 H-01 的核心修复：SELECT 曾被漏掉，导致聚焦下拉时按键改评级并写盘。
      if (isFormControlOrEditing(el)) return;

      // 5 空格：**不再对可激活元素静默让位**（SH-03，issue #32）。
      //   过去焦点停在底栏按钮/链接/role=option 上时，这里直接 return：空格
      //   要么原生再次激活那个按钮（例如重开导出弹窗），要么什么也不发生，
      //   既不设基准也没有任何反馈，与帮助弹窗「空格 = 设为基准」矛盾。
      //   现在交给下面的 `case ' '` 统一处理（触发 + preventDefault + 通知）。
      //   代价：BUTTON/SUMMARY 上空格不再触发原生激活（Enter 仍可激活）——
      //   这是「空格不吞键」的取舍，写进 PR 影响面。

      // 5.4 重做：Ctrl/Cmd+Shift+Z（issue #61 删除了右手 `Ctrl+Y`）。
      //     必须排在撤销分支**之前** —— 撤销只判 key，会连 Shift+Z 一起吞掉。
      //     同理也排在通用守卫之后：输入框里保持原生重做输入。
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        e.shiftKey &&
        (e.key === 'z' || e.key === 'Z')
      ) {
        if (onRedo) {
          e.preventDefault();
          onRedo();
        }
        return;
      }

      // 5.5 撤销：Ctrl/Cmd+Z（L-11，FR-04 起为多步）。刻意放在通用守卫**之后**——
      //     焦点在输入框/文本域里时，Ctrl+Z 必须留给原生「撤销输入」。
      //     也不与步骤 6 的组合键让路冲突：这里先返回，不会落到那句 return。
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        (e.key === 'z' || e.key === 'Z')
      ) {
        if (onUndo) {
          e.preventDefault();
          onUndo();
        }
        return;
      }

      // 5.6 打开导出弹窗：Ctrl/Cmd+E。
      //     单独一档的原因：步骤 6 会把所有带修饰键的按键直接 return，
      //     晚一步就永远收不到。也不与步骤 6 冲突 —— 这里先返回。
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        (e.key === 'e' || e.key === 'E')
      ) {
        if (onOpenExport) {
          e.preventDefault();
          onOpenExport();
        }
        return;
      }

      // 6 组合键让路（Ctrl+X/Ctrl+P 等不再误触评级/旗标并写盘）；Ctrl/Cmd+F 显式豁免。
      if ((e.ctrlKey || e.metaKey || e.altKey) && e.key !== 'f') return;

      // 6.4 左手色标：Shift+1…5 = 红/黄/绿/蓝/紫（issue #61）。
      //     按物理键位判断（Shift+1 的 e.key 是 `!`）。右手 6–9 / Shift+6 已删除。
      if (e.shiftKey && LABEL_BY_DIGIT_CODE[e.code]) {
        if (onLabel) {
          e.preventDefault();
          onLabel(LABEL_BY_DIGIT_CODE[e.code]);
        }
        return;
      }

      // Focus the grid search field via Ctrl/Cmd+F（issue #61 删除了右手 `/`）。
      //
      // 即使调用方没有接线 onFocusSearch，也必须在这里 return；否则 Ctrl+F
      // 会穿过第 6 步例外落进 `case 'f'`，误触「保留」。
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        if (onFocusSearch) {
          e.preventDefault();
          onFocusSearch();
        }
        return;
      }

      // 6.6 Alt 组合键一律让路。第 6 步对 `e.key !== 'f'` 留了例外（为了放过
      //     Ctrl/Cmd+F），Alt+F 也会穿过；issue #45 新增 `f` = 保留后，必须在
      //     这里把 Alt+F 关掉，否则浏览器菜单键会误触保留。
      if (e.altKey) return;

      // 6.7 钉左 / 钉右基准：Q / Shift+Q（issue #61，替代右手 `[` / `]`）。
      //     用物理键位 `e.code` 判定；Shift+Q 的 `e.key` 仍是 `Q`，靠 shiftKey 分流。
      //     issue #95：两个方向都是**切换**语义，长按的系统重复会按重复率反复
      //     「钉 → 取消」，松手时机决定最终状态 —— 只认首次 keydown。
      //     PB-2：焦点在宫格内时让路 —— 宫格不展示对比结果，改基准看不见效果；
      //     不 preventDefault，事件留给宫格自己的键盘导航。
      //     翻页键 A / D 刻意不拦重复（连续翻页是正常用法），也不受宫格焦点影响。
      if (e.code === 'KeyQ') {
        if (e.repeat) return;
        if (isFocusInsideGrid()) return;
        if (e.shiftKey) {
          if (onPinRight) {
            e.preventDefault();
            onPinRight();
          }
        } else if (onPinLeft) {
          e.preventDefault();
          onPinLeft();
        }
        return;
      }

      // 6.8 F1 打开帮助（issue #61，替代右手 `?` = Shift+/）。
      if (e.key === 'F1') {
        if (onOpenShortcutHelp) {
          e.preventDefault();
          onOpenShortcutHelp();
        }
        return;
      }

      switch (e.key) {
        // Navigation（issue #61：右手 `←` / `→` 已删除，只保留 A / D）
        case 'a':
        case 'A':
          e.preventDefault();
          onPrev();
          break;
        case 'd':
        case 'D':
          e.preventDefault();
          onNext();
          break;

        // Rating: 1 to 5
        case '1':
          e.preventDefault();
          onRate(1);
          break;
        case '2':
          e.preventDefault();
          onRate(2);
          break;
        case '3':
          e.preventDefault();
          onRate(3);
          break;
        case '4':
          e.preventDefault();
          onRate(4);
          break;
        case '5':
          e.preventDefault();
          onRate(5);
          break;
        // issue #61：清除只保留左手 `R`（右手 `0` / `U` 已删除）。
        case 'r':
        case 'R':
          e.preventDefault();
          // B2：优先走合并后的单次清除（一次写盘）；未接线时保留旧的双回调。
          if (onClear) onClear();
          else {
            onRate(0);
            onFlag('none');
          }
          break;

        // Pick / Reject（issue #61：保留只留左手 `F`，右手 `P` 已删除）
        case 'f':
        case 'F':
          e.preventDefault();
          onFlag('pick');
          break;
        case 'x':
        case 'X':
          e.preventDefault();
          onFlag('reject');
          break;

        // 色标只走上面的 Shift+1…5（issue #61 删除了右手 6–9 / Shift+6）。

        // 1:1 细节开关 (Z)。与 Ctrl+Z 撤销只差一个修饰键 —— 那两条已在
        // 更早的分支 return，这里到不了带修饰键的 z。
        case 'z':
        case 'Z':
          if (onToggleOneToOne) {
            e.preventDefault();
            onToggleOneToOne();
          }
          break;

        // Open in Photoshop / External app（issue #61：W 替代右手 O）
        case 'w':
        case 'W':
          e.preventDefault();
          onOpenExternal();
          break;

        // View mode toggles
        case 'c':
        case 'C':
          e.preventDefault();
          onToggleCompare();
          break;

        // Compare Swap (S)
        case 's':
        case 'S':
          if (onSwapCompare) {
            e.preventDefault();
            onSwapCompare();
          }
          break;

        // Pin Reference (B - Benchmark/Base)
        // issue #95：切换语义 + 长按重复 = 基准不确定，只认首次 keydown；
        // PB-2：焦点在宫格内时让路（不 preventDefault，事件留给宫格导航）。
        case 'b':
        case 'B':
          if (e.repeat) break;
          if (isFocusInsideGrid()) break;
          if (onTogglePinReference) {
            e.preventDefault();
            onTogglePinReference();
          }
          break;

        // 空格 = 把**当前照片**设为对比基准（已钉住则取消）。
        //
        // 曾复用 onPinRight，但无基准时 deriveCompareGroups 总让 right = compareIndex
        // 那张，于是单图视口下按空格会把**另一张**照片钉为基准，界面上完全看不出
        // 发生了什么 —— 与 ShortcutHelpModal 承诺的「空格 = 设为基准」矛盾。
        // `Shift+Q` 仍是"钉右窗格"（见上面的 KeyQ 分支），语义与空格不同。
        case ' ':
          if (onTogglePinCurrent) {
            e.preventDefault();
            // SH-03：无论焦点停在宫格、按钮还是链接，失败都不该是静默的。
            // #35：但 no-op（无 currentGroup）并非失败，而是「什么都没发生」，
            // 此时必须闭嘴 —— 否则用户会以为基准变了。
            const applied = onTogglePinCurrent();
            if (applied !== false) onNotify?.('已切换对比基准。');
          }
          break;

        // Metadata Editor（issue #61：G 替代右手 M）
        case 'g':
        case 'G':
          if (onOpenMetadataModal) {
            e.preventDefault();
            onOpenMetadataModal();
          }
          break;

        // Before / After Intra-Photo View Toggle（issue #61：只留左手 T，
        // 右手 Y 已删除）。
        case 't':
        case 'T':
          if (onToggleBeforeAfter) {
            e.preventDefault();
            onToggleBeforeAfter();
          }
          break;

        // Tonal Adjuster Panel Toggle (E)
        case 'e':
        case 'E':
          if (onToggleTonalPanel) {
            e.preventDefault();
            onToggleTonalPanel();
          }
          break;

        default:
          break;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const el = e.target as Element | null;

      // 按住 `V` 的复位必须早于 isDialogOpen 守卫（S-03）。按住期间若打开了
      // 任何弹窗，松键会被守卫整段吞掉 -> holdActiveRef 复位不了 -> 预览横幅常亮。
      // 松键复位是幂等的，故上提到守卫之前是安全的。
      //
      // issue #61：右手的 `\` 已删除；只有 holdActiveRef 为真时才复位，这样
      // `Ctrl+V` / 在文本框里键入 v 的松键不会误触；若按住期间弹窗抢走焦点，
      // 仍能正常结束（不依赖 keyup 目标）。
      if (e.key === 'v' || e.key === 'V') {
        if (!holdActiveRef.current) return;
        e.preventDefault();
        holdActiveRef.current = false;
        onHoldOriginalEnd?.();
        return;
      }

      if (isDialogOpen()) return;
      if (isFormControlOrEditing(el)) return;
    };

    // 复位兜底：窗口失焦 / 页面隐藏时若 `V` 仍处于按住态，强制结束预览，
    // 避免「松手事件丢失」导致横幅常亮。仅在真正按住时才调用（防误复位）。
    const resetHold = () => {
      if (!holdActiveRef.current) return;
      holdActiveRef.current = false;
      onHoldOriginalEnd?.();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', resetHold);
    document.addEventListener('visibilitychange', resetHold);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', resetHold);
      document.removeEventListener('visibilitychange', resetHold);
    };
  }, [
    onPrev,
    onNext,
    onRate,
    onFlag,
    onLabel,
    onClear,
    onOpenExternal,
    onToggleCompare,
    onSwapCompare,
    onTogglePinReference,
    onPinLeft,
    onPinRight,
    onTogglePinCurrent,
    onOpenMetadataModal,
    onToggleBeforeAfter,
    onToggleTonalPanel,
    onToggleOneToOne,
    onHoldOriginalStart,
    onHoldOriginalEnd,
    onFocusSearch,
    onOpenShortcutHelp,
    onOpenExport,
    onUndo,
    onRedo,
  ]);
}
