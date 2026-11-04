/**
 * 更新弹窗的交互与无障碍契约（issue #43-PB）。
 *
 * 这里锁的是「最容易做错」的三件事：
 * 1. X / Esc 只等于「本次暂不更新」，**不许**写持久标记（所以组件只回调 `onClose`，
 *    复选框状态原样不动，写盘由 hook 在 `onLater` 路径才做）；
 * 2. 初始焦点落在「本次暂不更新」，不能落在复选框（回车/Space 会误勾永久跳过）；
 * 3. 下载完成后进入终态：进度区独占 `aria-live`，按钮保持禁用且解释常驻屏幕。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpdateDialog, type UpdateDialogProps } from './UpdateDialog';

const baseProps = (overrides: Partial<UpdateDialogProps> = {}): UpdateDialogProps => ({
  isOpen: true,
  version: '2.0.6',
  body: '修复若干已知问题',
  phase: 'idle',
  progressText: '',
  error: null,
  skipChecked: false,
  onSkipCheckedChange: vi.fn(),
  onInstall: vi.fn(),
  onLater: vi.fn(),
  onClose: vi.fn(),
  onRetry: vi.fn(),
  onOpenReleasePage: vi.fn(),
  ...overrides,
});

describe('UpdateDialog —— 结构与文案', () => {
  it('标题带版本号，正文显示更新说明，主次按钮文案按约定', () => {
    render(<UpdateDialog {...baseProps()} />);
    expect(screen.getByRole('heading', { name: '发现新版本 2.0.6' })).toBeInTheDocument();
    expect(screen.getByText(/修复若干已知问题/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下载并安装' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '本次暂不更新' })).toBeInTheDocument();
  });

  it('复选框文案写明失效规则（有新版本时会再次提醒）', () => {
    render(<UpdateDialog {...baseProps()} />);
    expect(
      screen.getByRole('checkbox', { name: /不再提示 v2\.0\.6（有新版本发布时会再次提醒）/ }),
    ).toBeInTheDocument();
  });

  it('勾选复选框只回调，不由组件自己写任何东西', async () => {
    const onSkipCheckedChange = vi.fn();
    render(<UpdateDialog {...baseProps({ onSkipCheckedChange })} />);
    await userEvent.click(screen.getByRole('checkbox'));
    expect(onSkipCheckedChange).toHaveBeenCalledWith(true);
  });

  it('静态说明常驻屏幕（解释自动启动与手动兜底，不依赖 hover/title）', () => {
    render(<UpdateDialog {...baseProps()} />);
    const hint = screen.getByText(/安装完成后会自动启动/);
    expect(hint).toBeVisible();
    expect(hint).toHaveTextContent(/若没有自动启动，请从开始菜单手动打开/);
  });
});

describe('UpdateDialog —— 关闭路径', () => {
  it('初始焦点在「本次暂不更新」，不在复选框与主按钮', () => {
    render(<UpdateDialog {...baseProps()} />);
    expect(screen.getByRole('button', { name: '本次暂不更新' })).toHaveFocus();
    expect(screen.getByRole('checkbox')).not.toHaveFocus();
    expect(screen.getByRole('button', { name: '下载并安装' })).not.toHaveFocus();
  });

  it('X 只走 onClose：不触发 onLater，也不改复选框', async () => {
    const onClose = vi.fn();
    const onLater = vi.fn();
    const onSkipCheckedChange = vi.fn();
    render(<UpdateDialog {...baseProps({ onClose, onLater, onSkipCheckedChange })} />);
    await userEvent.click(screen.getByRole('button', { name: '关闭弹窗' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onLater).not.toHaveBeenCalled();
    expect(onSkipCheckedChange).not.toHaveBeenCalled();
  });

  it('Esc 只走 onClose：不触发 onLater（与 X 同一语义）', () => {
    const onClose = vi.fn();
    const onLater = vi.fn();
    render(<UpdateDialog {...baseProps({ onClose, onLater })} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onLater).not.toHaveBeenCalled();
  });

  it('次按钮走 onLater（是否写盘由 hook 决定）', async () => {
    const onLater = vi.fn();
    render(<UpdateDialog {...baseProps({ onLater })} />);
    await userEvent.click(screen.getByRole('button', { name: '本次暂不更新' }));
    expect(onLater).toHaveBeenCalledTimes(1);
  });
});

describe('UpdateDialog —— 进度与终态', () => {
  it('下载中：进度独占 aria-live=polite，两个按钮都禁用且解释常驻', () => {
    render(
      <UpdateDialog
        {...baseProps({ phase: 'downloading', progressText: '正在下载 42%（84.0 MB / 200.0 MB）' })}
      />,
    );
    const liveRegions = document.querySelectorAll('[aria-live]');
    expect(liveRegions).toHaveLength(1);
    expect(liveRegions[0]).toHaveAttribute('aria-live', 'polite');
    expect(liveRegions[0]).toHaveTextContent('正在下载 42%');
    expect(screen.getByRole('button', { name: '下载并安装' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '本次暂不更新' })).toBeDisabled();
    // 禁用原因不是 title，而是屏幕上常驻的一句
    expect(screen.getByText(/安装完成后会自动启动/)).toBeVisible();
  });

  it('安装中：进入终态，不再显示百分比、按钮不可点、X 也被禁用', () => {
    render(
      <UpdateDialog
        {...baseProps({
          phase: 'installing',
          progressText: '正在安装，完成后会自动启动，请稍候…',
        })}
      />,
    );
    expect(screen.getByText(/正在安装，完成后会自动启动/)).toBeInTheDocument();
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.getByRole('button', { name: '下载并安装' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '本次暂不更新' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '关闭弹窗' })).toBeDisabled();
  });

  it('失败：role=alert 显示原因，弹窗不关，可重试', async () => {
    const onRetry = vi.fn();
    render(
      <UpdateDialog
        {...baseProps({ phase: 'failed', error: '下载失败：网络不可达', onRetry })}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/下载失败：网络不可达/);
    await userEvent.click(screen.getByRole('button', { name: '重试下载' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '本次暂不更新' })).toBeEnabled();
  });

  it('失败时给出打开发布页的出口（外链不依赖 hover）', async () => {
    const onOpenReleasePage = vi.fn();
    render(<UpdateDialog {...baseProps({ phase: 'failed', error: '校验失败', onOpenReleasePage })} />);
    await userEvent.click(screen.getByRole('button', { name: '打开发布页' }));
    expect(onOpenReleasePage).toHaveBeenCalledTimes(1);
  });
});
