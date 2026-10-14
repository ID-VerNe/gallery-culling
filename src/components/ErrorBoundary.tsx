/**
 * 顶层错误边界。
 *
 * 没有它，任何渲染期 accessor 抛错（万张照片里某个 EXIF 畸形、字段缺失、
 * 扩展名异常）都会让整棵 React 树白屏，用户只剩一个空白窗口 —— 没有错误
 * 信息、没有「重试」出口，只能杀进程重来，且不知道是哪张照片引起的。
 *
 * 这里刻意只做**最小恢复卡**：说清发生了什么 + 给一个「重新加载」。不做逐面板
 * 边界，也不做错误详情堆栈展示 —— 那是过度设计；先把「白屏无出口」这个
 * 灾难性缺口堵上。
 */
import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: unknown): State {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    // 留下可诊断的现场：真实环境（无 DevTools 时）这是唯一的线索来源。
    // eslint-disable-next-line no-console
    console.error('未捕获的渲染错误', error, info.componentStack);
  }

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        role="alert"
        className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-neutral-900 p-8 text-neutral-100"
      >
        <h1 className="text-xl font-semibold">出了点问题</h1>
        <p className="max-w-md text-center text-sm text-neutral-400">
          应用在渲染照片数据时遇到了一个无法恢复的错误，通常是某张照片的元数据
          读取失败所致。你的评级与旗标都已写入 XMP，不会丢失。
        </p>
        {this.state.message ? (
          <p className="max-w-md break-words text-center font-mono text-xs text-neutral-500">
            {this.state.message}
          </p>
        ) : null}
        <button
          type="button"
          onClick={this.handleReload}
          className="focus-ring mt-2 rounded-md bg-white/10 px-4 py-2 text-sm font-medium transition-colors hover:bg-white/20"
        >
          重新加载
        </button>
      </div>
    );
  }
}
