/**
 * 导出域四个纯展示组件的契约测试。
 *
 * 合成一个文件是因为它们的断言量都不大，且共同守卫同一件事：
 * **呈现组件只翻译 props，不做判断**。任何一条开始读全局状态或算业务规则，
 * 都会在这里先红。
 *
 * 重点保护 `LumenGateNotice`：它绝不能占用 `alert` / `status` / `aria-live`，
 * 否则会与结果条、进度条的播报语义打架（Step 7 接入时最容易踩到）。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExportResultPanel } from './ExportResultPanel';
import { ExportModeSelector } from './ExportModeSelector';
import { RenderOptions } from './RenderOptions';
import { LumenGateNotice } from './LumenGateNotice';

describe('ExportResultPanel', () => {
  it('无结果时不渲染任何节点', () => {
    const { container } = render(<ExportResultPanel result={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('失败：amber + AlertTriangle + role=alert', () => {
    render(<ExportResultPanel result={{ message: '失败 1 个', failed: true }} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('失败 1 个');
    expect(alert.className).toContain('text-amber-200');
    expect(alert.className).not.toContain('emerald');
    expect(alert.querySelector('svg')?.getAttribute('class')).toContain(
      'lucide-triangle-alert',
    );
  });

  it('成功：emerald + CheckCircle2 + role=status', () => {
    render(<ExportResultPanel result={{ message: '已导出 3 个', failed: false }} />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('已导出 3 个');
    expect(status.className).toContain('emerald');
    expect(status.className).not.toContain('amber');
    expect(status.querySelector('svg')?.getAttribute('class')).toContain(
      'lucide-circle-check',
    );
  });

  it('两种态互斥：同一时刻只有一个 live region', () => {
    const { rerender } = render(
      <ExportResultPanel result={{ message: 'x', failed: true }} />,
    );
    expect(screen.queryByRole('status')).toBeNull();
    rerender(<ExportResultPanel result={{ message: 'x', failed: false }} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('ExportModeSelector', () => {
  it('两种模式都展示标签与一行说明', () => {
    render(<ExportModeSelector value="copy" onChange={vi.fn()} />);
    expect(screen.getByLabelText(/原片复制/)).toBeChecked();
    expect(screen.getByText('复制 RAW / JPG 原文件')).toBeInTheDocument();
    expect(screen.getByText('按 .lumen 调色渲染成片')).toBeInTheDocument();
  });

  it('切换时回传模式值', () => {
    const onChange = vi.fn();
    render(<ExportModeSelector value="copy" onChange={onChange} />);
    fireEvent.click(screen.getByLabelText(/调色成片/));
    expect(onChange).toHaveBeenCalledWith('render');
  });

  it('disabled 时两个选项都不可点', () => {
    render(<ExportModeSelector value="copy" onChange={vi.fn()} disabled />);
    expect(screen.getByLabelText(/原片复制/)).toBeDisabled();
    expect(screen.getByLabelText(/调色成片/)).toBeDisabled();
  });
});

describe('RenderOptions', () => {
  const base = {
    format: 'jpg' as const,
    longEdge: 0,
    qualityText: '92',
    onChangeFormat: vi.fn(),
    onChangeLongEdge: vi.fn(),
    onChangeQuality: vi.fn(),
  };

  it('JPEG 才显示质量输入', () => {
    const { rerender } = render(<RenderOptions {...base} />);
    expect(screen.getByLabelText('JPEG 质量')).toBeInTheDocument();
    rerender(<RenderOptions {...base} format="tif" />);
    expect(screen.queryByLabelText('JPEG 质量')).toBeNull();
    rerender(<RenderOptions {...base} format="dng" />);
    expect(screen.queryByLabelText('JPEG 质量')).toBeNull();
  });

  it('三种格式都在，切换回传格式值', () => {
    const onChangeFormat = vi.fn();
    render(<RenderOptions {...base} onChangeFormat={onChangeFormat} />);
    expect(screen.getByLabelText('JPEG')).toBeChecked();
    fireEvent.click(screen.getByLabelText('TIFF'));
    expect(onChangeFormat).toHaveBeenCalledWith('tif');
  });

  it('长边档位齐全，切换回传数字而非字符串', () => {
    const onChangeLongEdge = vi.fn();
    render(<RenderOptions {...base} onChangeLongEdge={onChangeLongEdge} />);
    const select = screen.getByLabelText('长边尺寸');
    expect(select.querySelectorAll('option')).toHaveLength(4);
    fireEvent.change(select, { target: { value: '2560' } });
    expect(onChangeLongEdge).toHaveBeenCalledWith(2560);
  });

  it('质量输入原样回传文本（保留中间态，不做夹取）', () => {
    const onChangeQuality = vi.fn();
    render(<RenderOptions {...base} onChangeQuality={onChangeQuality} />);
    fireEvent.change(screen.getByLabelText('JPEG 质量'), {
      target: { value: '9' },
    });
    expect(onChangeQuality).toHaveBeenCalledWith('9');
  });

  it('质量失焦时回调规整（不实时改写文本）', () => {
    const onCommitQuality = vi.fn();
    render(<RenderOptions {...base} onCommitQuality={onCommitQuality} />);
    fireEvent.blur(screen.getByLabelText('JPEG 质量'));
    expect(onCommitQuality).toHaveBeenCalledTimes(1);
  });

  it('disabled 传导到格式、长边、质量三处', () => {
    render(<RenderOptions {...base} disabled />);
    expect(screen.getByLabelText('JPEG')).toBeDisabled();
    expect(screen.getByLabelText('长边尺寸')).toBeDisabled();
    expect(screen.getByLabelText('JPEG 质量')).toBeDisabled();
  });
});

describe('LumenGateNotice', () => {
  it('可用时不渲染任何节点', () => {
    const { container } = render(<LumenGateNotice status="available" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('探测中：说明正在检测', () => {
    render(<LumenGateNotice status="probing" />);
    expect(screen.getByText(/正在检测 LUMEN RAW 引擎/)).toBeInTheDocument();
  });

  it('不可用：展示原因与「去设置」入口', () => {
    const onOpenSettings = vi.fn();
    render(
      <LumenGateNotice
        status="unavailable"
        detail="未找到 lumen-cli.exe"
        onOpenSettings={onOpenSettings}
      />,
    );
    expect(screen.getByText(/未找到 lumen-cli\.exe/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /去设置/ }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('不可用且无原因：用兜底句，不出现空冒号', () => {
    render(<LumenGateNotice status="unavailable" detail="   " />);
    expect(screen.getByText(/未检测到可用的 lumen-cli/)).toBeInTheDocument();
  });

  it('不传 onOpenSettings 时不渲染按钮', () => {
    render(<LumenGateNotice status="unavailable" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('角色选择：探测中走 status、不可用走 alert，两者互斥且都不声明 aria-live', () => {
    const { container, rerender } = render(<LumenGateNotice status="probing" />);
    expect(screen.getByRole('status')).toHaveTextContent(/正在检测/);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.querySelector('[aria-live]')).toBeNull();

    rerender(<LumenGateNotice status="unavailable" detail="x" />);
    expect(screen.getByRole('alert')).toHaveTextContent(/引擎不可用/);
    expect(screen.queryByRole('status')).toBeNull();
    // 进度条独占 aria-live="polite"，这里绝不能抢
    expect(container.querySelector('[aria-live]')).toBeNull();
  });
});
