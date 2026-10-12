import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

/**
 * LUMEN RAW 设置体验的薄封装（M-15）。
 *
 * 刻意**不**并入 `services/api.ts`：
 *  - `probe_lumen_cmd` 是与设置弹窗一起新引入的后端命令，后端可能尚未落地；
 *  - 它读的是**参数里的路径**（未保存的输入框内容），语义上不属于「读已保存设置」
 *    的那组命令；
 *  - 在独立文件里做**缺省容错**，后端缺失时 `tsc` 与 UI 都不会因此崩。
 */
export interface LumenProbeResult {
  available: boolean;
  /** 引擎版本；不可用或后端未返回时为 null。 */
  version: string | null;
  /** 不可用时的可读原因（后端给的诊断信息，原样透传，前端不改写）。 */
  error: string | null;
}

/**
 * 用**参数里的路径**探测引擎是否可用（设置面板的「测试连接」）。
 *
 * 与 `lumen_status_cmd` 的区别：后者只读**已保存**的设置、且命中运行期缓存时
 * 不再真跑进程 —— 所以测不到用户正在手输的路径。本命令专为「测试未保存路径」而生。
 *
 * 返回对象按 `{ available, version?, error? }` 解析并做缺省容错：字段缺失一律
 * 归一成 `false / null / null`，不把 `undefined` 泄漏到 UI。invoke 本身的失败
 * **不吞**（交由调用方展示错误，绝不静默）。
 */
export async function probeLumen(cliPath: string): Promise<LumenProbeResult> {
  const raw = await invoke<Partial<LumenProbeResult> | null>('probe_lumen_cmd', {
    cliPath: cliPath ?? '',
  });
  return {
    available: Boolean(raw?.available),
    version: raw?.version ?? null,
    error: raw?.error ?? null,
  };
}

/**
 * 弹出系统文件对话框选择 `lumen-cli` 可执行文件，返回所选路径（取消则 null）。
 * 与设置里 Photoshop 路径的「浏览」同款过滤器（只列 exe/app）。
 */
export async function pickLumenCliPath(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    title: '选择 lumen-cli 可执行文件 (lumen-cli.exe)',
    filters: [{ name: 'Executable', extensions: ['exe', 'app'] }],
  });
  return typeof selected === 'string' ? selected : null;
}
