/**
 * 导出域五个纯展示组件的契约测试。
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
import { OverwriteToggle } from './OverwriteToggle';
import { RenderOptions } from './RenderOptions';
import { WatermarkOptions } from './WatermarkOptions';
import { LumenGateNotice } from './LumenGateNotice';

describe('ExportResultPanel', () => {
  const base = { message: 'x', failed: false, failures: [], folder: 'D:/out' };

  it('无结果时不渲染任何节点', () => {
    const { container } = render(<ExportResultPanel result={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('失败：amber + AlertTriangle + role=alert', () => {
    render(<ExportResultPanel result={{ ...base, message: '失败 1 个', failed: true }} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('失败 1 个');
    expect(alert.className).toContain('text-amber-200');
    expect(alert.className).not.toContain('emerald');
    expect(alert.querySelector('svg')?.getAttribute('class')).toContain(
      'lucide-triangle-alert',
    );
  });

  it('成功：emerald + CheckCircle2 + role=status', () => {
    render(<ExportResultPanel result={{ ...base, message: '已导出 3 个' }} />);
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
      <ExportResultPanel result={{ ...base, message: 'x', failed: true }} />,
    );
    expect(screen.queryByRole('status')).toBeNull();
    rerender(<ExportResultPanel result={{ ...base, message: 'x', failed: false }} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('失败明细 ≤3 条：正文说全，不出展开区', () => {
    render(
      <ExportResultPanel
        result={{
          ...base,
          failed: true,
          message: '导出未完全成功：失败 2 个',
          failures: [
            { path: 'a.NEF', reason: '拒绝访问' },
            { path: 'b.NEF', reason: '磁盘已满' },
          ],
        }}
      />,
    );
    expect(screen.queryByText(/查看全部/)).toBeNull();
  });

  it('失败明细 >3 条：给展开区，全部原因都在里面，并指出清单文件位置', () => {
    const failures = Array.from({ length: 5 }, (_, i) => ({
      path: `IMG_000${i}.NEF`,
      reason: `原因${i}`,
    }));
    render(
      <ExportResultPanel
        result={{ ...base, failed: true, message: '导出未完全成功：失败 5 个', failures }}
      />,
    );

    // 正文只放 3 条，但必须给出看全的入口
    const summary = screen.getByText(/查看全部 5 条失败原因/);
    expect(summary).toBeInTheDocument();
    for (let i = 0; i < 5; i += 1) {
      expect(screen.getByText(new RegExp(`IMG_000${i}\\.NEF`))).toBeInTheDocument();
    }
    expect(screen.getByText(/\.gallery-export\.json/)).toBeInTheDocument();
  });

  it('传 onOpenFolder 才渲染「打开目录」，点击回传结果里记录的目录', () => {
    const onOpenFolder = vi.fn();
    const { rerender } = render(
      <ExportResultPanel result={{ ...base, folder: 'D:/out/render' }} />,
    );
    expect(screen.queryByRole('button', { name: /打开目录/ })).toBeNull();

    rerender(
      <ExportResultPanel
        result={{ ...base, folder: 'D:/out/render' }}
        onOpenFolder={onOpenFolder}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /打开目录/ }));
    // 用的是 result.folder，不是任何外部状态
    expect(onOpenFolder).toHaveBeenCalledWith('D:/out/render');
  });
});

describe('OverwriteToggle', () => {
  it('关闭时说明「跳过」，勾选后改成风险提示', () => {
    const onChange = vi.fn();
    const { rerender } = render(<OverwriteToggle checked={false} onChange={onChange} />);
    expect(screen.getByLabelText(/覆盖目标目录中的同名文件/)).not.toBeChecked();
    expect(screen.getByText(/一律跳过/)).toBeInTheDocument();

    rerender(<OverwriteToggle checked onChange={onChange} />);
    expect(screen.getByText(/无法撤销/)).toBeInTheDocument();
  });

  it('勾选回传布尔值，disabled 时不可点', () => {
    const onChange = vi.fn();
    const { rerender } = render(<OverwriteToggle checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText(/覆盖目标目录中的同名文件/));
    expect(onChange).toHaveBeenCalledWith(true);

    rerender(<OverwriteToggle checked={false} onChange={onChange} disabled />);
    expect(screen.getByLabelText(/覆盖目标目录中的同名文件/)).toBeDisabled();
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

  it('仅含 JPG 的候选 + JPEG 输出 → 提示二次压缩，并挂到质量输入的描述上', () => {
    render(<RenderOptions {...base} jpgOnlyCount={2} />);
    const tip = screen.getByText(/2 组仅含 JPG/);
    expect(tip).toHaveTextContent(/二次压缩/);
    // 这是静态说明，不能抢结果条/进度条的 live region 语义
    expect(tip.getAttribute('role')).toBeNull();
    expect(tip.closest('[aria-live]')).toBeNull();
    // 读屏聚焦质量输入时应能读到它
    expect(screen.getByLabelText('JPEG 质量')).toHaveAttribute(
      'aria-describedby',
      tip.id,
    );
  });

  it('没有仅含 JPG 的候选 → 不提示、不挂 aria-describedby', () => {
    render(<RenderOptions {...base} jpgOnlyCount={0} />);
    expect(screen.queryByText(/仅含 JPG/)).toBeNull();
    expect(screen.getByLabelText('JPEG 质量')).not.toHaveAttribute('aria-describedby');
  });

  it('非 JPEG 输出 → 不提示（TIFF / DNG 无二次压缩概念）', () => {
    const { rerender } = render(<RenderOptions {...base} jpgOnlyCount={2} format="tif" />);
    expect(screen.queryByText(/仅含 JPG/)).toBeNull();
    rerender(<RenderOptions {...base} jpgOnlyCount={2} format="dng" />);
    expect(screen.queryByText(/仅含 JPG/)).toBeNull();
    rerender(<RenderOptions {...base} jpgOnlyCount={2} format="jpg" />);
    expect(screen.getByText(/2 组仅含 JPG/)).toBeInTheDocument();
  });

  it('质量被规整时把说明挂到输入框上（静默改写不可接受）', () => {
    render(<RenderOptions {...base} qualityNotice="已调整为 50（允许 50–100）" />);
    const tip = screen.getByText(/已调整为 50/);
    expect(screen.getByLabelText('JPEG 质量')).toHaveAttribute(
      'aria-describedby',
      tip.id,
    );
  });

  it('提示与规整说明同时存在时，aria-describedby 两个 id 都挂上', () => {
    render(
      <RenderOptions {...base} jpgOnlyCount={1} qualityNotice="已调整为 100（允许 50–100）" />,
    );
    const describedBy =
      screen.getByLabelText('JPEG 质量').getAttribute('aria-describedby') ?? '';
    expect(describedBy.split(/\s+/)).toHaveLength(2);
  });

  it('非 JPEG 时规整说明也不显示（质量输入本身不在了）', () => {
    render(<RenderOptions {...base} format="tif" qualityNotice="已调整为 50（允许 50–100）" />);
    expect(screen.queryByText(/已调整为/)).toBeNull();
  });
});

describe('WatermarkOptions', () => {
  const base = {
    enabled: false,
    preset: 'gallery' as const,
    size: 14,
    onChangeEnabled: vi.fn(),
    onChangePreset: vi.fn(),
    onChangeSize: vi.fn(),
  };

  it('默认折叠：水印是可选项，不该占每次导出的注意力', () => {
    const { container } = render(<WatermarkOptions {...base} />);
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByText('底边水印')).toBeInTheDocument();
  });

  it('未勾选时不出现配色与高度控件（没有可用的东西就不摆出来）', () => {
    render(<WatermarkOptions {...base} />);
    expect(screen.getByLabelText('给成片加底边水印')).not.toBeChecked();
    expect(screen.queryByLabelText('配色')).toBeNull();
    expect(screen.queryByLabelText(/底边高度/)).toBeNull();
  });

  it('勾选后展开配色与高度，四个配色全部来自配置表', () => {
    render(<WatermarkOptions {...base} enabled />);
    const select = screen.getByLabelText('配色');
    expect(select.querySelectorAll('option')).toHaveLength(4);
    // 预设名与后端 PRESET_NAMES 对齐：多一个名就是一种必然失败的导出
    expect(
      Array.from(select.querySelectorAll('option')).map((o) => o.getAttribute('value')),
    ).toEqual(['gallery', 'noir', 'travel', 'sage']);
    expect(screen.getByLabelText('配色')).toHaveValue('gallery');
  });

  it('高度滑杆按后端区间 8–35，回传数字', () => {
    const onChangeSize = vi.fn();
    render(<WatermarkOptions {...base} enabled onChangeSize={onChangeSize} />);
    const slider = screen.getByLabelText(/底边高度/);
    expect(slider).toHaveAttribute('min', '8');
    expect(slider).toHaveAttribute('max', '35');
    expect(slider).toHaveValue('14');
    fireEvent.change(slider, { target: { value: '28' } });
    expect(onChangeSize).toHaveBeenCalledWith(28);
  });

  it('勾选与配色改动只回传值，组件不自己算规则', () => {
    const onChangeEnabled = vi.fn();
    const onChangePreset = vi.fn();
    render(
      <WatermarkOptions
        {...base}
        enabled
        onChangeEnabled={onChangeEnabled}
        onChangePreset={onChangePreset}
      />,
    );
    fireEvent.click(screen.getByLabelText('给成片加底边水印'));
    expect(onChangeEnabled).toHaveBeenCalledWith(false);
    fireEvent.change(screen.getByLabelText('配色'), { target: { value: 'noir' } });
    expect(onChangePreset).toHaveBeenCalledWith('noir');
  });

  it('disabled 时勾选框、配色、高度全部禁用', () => {
    render(<WatermarkOptions {...base} enabled disabled />);
    expect(screen.getByLabelText('给成片加底边水印')).toBeDisabled();
    expect(screen.getByLabelText('配色')).toBeDisabled();
    expect(screen.getByLabelText(/底边高度/)).toBeDisabled();
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
