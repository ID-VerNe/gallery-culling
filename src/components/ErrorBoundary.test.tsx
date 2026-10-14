/**
 * 顶层错误边界：渲染期抛错必须落到恢复卡，而不是整棵树白屏。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary';

/** 渲染期必炸的子组件。 */
function Boom({ shouldThrow = true }: { shouldThrow?: boolean }) {
  if (shouldThrow) {
    throw new Error('EXIF 解析失败: IMG_0042.CR3');
  }
  return <p>正常内容</p>;
}

/** 屏蔽 React 的错误日志噪声，让测试输出干净。 */
function silenceConsoleError() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

describe('ErrorBoundary', () => {
  it('子组件渲染抛错时渲染恢复卡，而非白屏', () => {
    const spy = silenceConsoleError();
    try {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      );

      // 恢复卡可见
      expect(screen.getByRole('alert')).toBeTruthy();
      expect(screen.getByText(/出了点问题/)).toBeTruthy();
      expect(screen.getByRole('button', { name: /重新加载/ })).toBeTruthy();
      // 错误原因必须透出，否则用户无从判断是不是自己的照片有问题
      expect(screen.getByText(/IMG_0042\.CR3/)).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it('不抛错时正常渲染子组件，不显示恢复卡', () => {
    render(
      <ErrorBoundary>
        <Boom shouldThrow={false} />
      </ErrorBoundary>,
    );

    expect(screen.getByText('正常内容')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('componentDidCatch 记录错误现场（真实环境无 DevTools 时是唯一线索）', () => {
    const spy = silenceConsoleError();
    try {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      );
      expect(spy).toHaveBeenCalled();
      // React 自己也会打 console.error（边界兜底告警），故检查所有调用里是否有我们那条。
      const logged = spy.mock.calls.map((c) => String(c[0]));
      expect(
        logged.some((m) => m.includes('未捕获的渲染错误')),
        `实际日志: ${JSON.stringify(logged)}`,
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
