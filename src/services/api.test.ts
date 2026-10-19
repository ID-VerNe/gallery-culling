/**
 * api 层的**IPC 载荷契约**测试。
 *
 * 为什么不放在组件测试里：这些键的有无是后端契约的一部分（`longEdge: 0`
 * 要被翻成 `null`、水印没勾就整个省掉 `watermark` 键），而组件测试只能
 * 覆盖「当前 UI 会怎么传」。api 是公开函数，别的调用方（未来的脚本入口、
 * 重构后的新弹窗）直接用它时，翻译规则必须仍然成立。
 *
 * 断言只看 `invoke` 收到的载荷，不看返回值形状 —— 那是 Rust 侧的事。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { api } from './api';
import {
  invokeCount,
  lastInvokeArgs,
  mockInvokeCommand,
  resetInvokeMocks,
} from '../test/setup';
import type { ExportItem, WatermarkOptions } from '../types';

const items: ExportItem[] = [{ baseName: 'IMG_0001', jpgPath: 'D:/s/IMG_0001.jpg' }];
const ok = { exported: 1, skipped: 0, failed: [] };

const call = (watermark?: WatermarkOptions | null, longEdge = 0) =>
  api.batchRenderExport(items, 'D:/out', 'jpg', longEdge, 92, false, watermark);

describe('batchRenderExport 载荷', () => {
  beforeEach(() => {
    resetInvokeMocks();
    mockInvokeCommand('batch_render_export_cmd', ok);
  });

  it('长边 0 翻成 null（0 会被渲染器当成长边 0 像素）', async () => {
    await call(null, 0);
    expect(lastInvokeArgs('batch_render_export_cmd')).toMatchObject({ longEdge: null });
  });

  it('长边非 0 原样传数字', async () => {
    await call(null, 2560);
    expect(lastInvokeArgs('batch_render_export_cmd')).toMatchObject({ longEdge: 2560 });
  });

  it('没要水印：null → 整个 watermark 键都不出现', async () => {
    await call(null);
    const args = lastInvokeArgs('batch_render_export_cmd') as Record<string, unknown>;
    // 键不存在 ≠ enabled:false。后端清单只给「要求过水印」的批次记字段，
    // 这里少一个键，导出的 .gallery-export.json 就少两个字段。
    expect(Object.keys(args)).not.toContain('watermark');
  });

  it('传了 enabled:false 同样不出现（api 不替调用方猜意图）', async () => {
    await call({ enabled: false, preset: 'gallery', size: 14 });
    const args = lastInvokeArgs('batch_render_export_cmd') as Record<string, unknown>;
    expect(Object.keys(args)).not.toContain('watermark');
  });

  it('enabled:true 才带上完整对象', async () => {
    await call({ enabled: true, preset: 'noir', size: 28 });
    expect(lastInvokeArgs('batch_render_export_cmd')).toMatchObject({
      watermark: { enabled: true, preset: 'noir', size: 28 },
    });
  });

  it('返回后端的 outcome（不含水印计数 —— 那在清单文件里）', async () => {
    await expect(call(null)).resolves.toEqual(ok);
    expect(invokeCount('batch_render_export_cmd')).toBe(1);
  });
});
