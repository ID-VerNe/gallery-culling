/**
 * 前端测试基座的统一环境。
 *
 * 关键约定：**所有 Tauri 边界都走 `src/services/api.ts`**，所以只 mock 三个
 * 模块就能截获整个应用的 IPC —— 测试断言的是 `invoke` 收到的**命令名与参数**，
 * 而不是某个组件内部实现。
 *
 * `invoke` 被做成可编程的 spy：
 *  - `mockInvokeCommand('lumen_preview_cmd', value)` 按命令名注册返回值；
 *  - `mockInvokeHandler(fn)` 全量接管（抛错、动态响应）；
 *  - `invokeCalls('lumen_preview_cmd')` 取出历史调用（含参数），用于
 *    "不该发请求""不该重试成风暴"这类负向断言。
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

/* -------------------------------------------------------------------------- */
/* invoke: 命令名 -> 返回值 / 抛出                                              */
/* -------------------------------------------------------------------------- */

export type InvokeArgs = Record<string, unknown> | undefined;

interface InvokeCall {
  command: string;
  args: InvokeArgs;
}

const recordedCalls: InvokeCall[] = [];

/** 命令名 -> 返回值（可能是函数式，按 args 求值）。 */
const commandResults = new Map<string, unknown>();
/** 命令名 -> 显式抛错。 */
const commandErrors = new Map<string, Error>();
/** 全量接管；设置后 commandResults / commandErrors 被忽略。 */
let invokeHandler: ((command: string, args: InvokeArgs) => unknown) | null = null;

/** 未注册的命令 = Tauri 侧 "command not found"。默认让测试炸出来，而不是静默返回 undefined。 */
class UnmockedCommandError extends Error {
  constructor(command: string) {
    super(
      `[test] invoke("${command}") 未注册。用 mockInvokeCommand('${command}', ...) ` +
        `或 mockInvokeHandler(...) 先声明它。`,
    );
    this.name = 'UnmockedCommandError';
  }
}

const invokeSpy = vi.fn(async (command: string, args?: InvokeArgs) => {
  recordedCalls.push({ command, args });

  if (invokeHandler) return invokeHandler(command, args);

  const err = commandErrors.get(command);
  if (err) throw err;

  if (!commandResults.has(command)) throw new UnmockedCommandError(command);

  const value = commandResults.get(command);
  return typeof value === 'function' ? (value as (a: InvokeArgs) => unknown)(args) : value;
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeSpy,
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
  convertFileSrc_: vi.fn(),
}));

vi.mock('@tauri-apps/api', () => ({
  invoke: invokeSpy,
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
}));

/* -------------------------------------------------------------------------- */
/* event: Tauri 事件总线（进度事件订阅，M-05）                                   */
/* -------------------------------------------------------------------------- */

export interface MockEvent<T = unknown> {
  event: string;
  id: number;
  payload: T;
}

type EventHandler = (event: MockEvent) => void;

/** 事件名 -> 已注册的监听器集合。 */
const eventListeners = new Map<string, Set<EventHandler>>();
let nextEventId = 1;

/**
 * 从测试里派发一个 Tauri 事件（`listen()` 订阅后即可收到）。
 *
 * 与真实后端一致：`listen` 是异步的，handler 在微任务之后才注册。测试若在
 * `render` 后立刻派发，需要先 `await` 一个 tick 或包在 `waitFor` 里。
 */
export function emitMockEvent<T = unknown>(name: string, payload: T): void {
  const handlers = eventListeners.get(name);
  if (!handlers) return;
  const event: MockEvent<T> = { event: name, id: nextEventId++, payload };
  handlers.forEach((h) => h(event as MockEvent));
}

/** 清空已注册的事件监听器（套件之间隔离）。 */
export function resetMockEvents(): void {
  eventListeners.clear();
  nextEventId = 1;
}

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: EventHandler) => {
    if (!eventListeners.has(name)) eventListeners.set(name, new Set());
    eventListeners.get(name)!.add(handler);
    return () => {
      eventListeners.get(name)?.delete(handler);
    };
  }),
}));

/* -------------------------------------------------------------------------- */
/* window: Tauri 窗口钩子（关闭前 flush，M-17）                                  */
/* -------------------------------------------------------------------------- */

type CloseRequestedHandler = (event: { preventDefault: () => void }) => void;
let closeRequestedHandler: CloseRequestedHandler | null = null;
/** 关闭请求里 `preventDefault()` 被调用的次数（区分"拦截后关闭"与"放行原生关闭"）。 */
let closePreventCount = 0;
/** `destroy()` 被调用的次数（"X 到底有没有真的关窗"的硬断言）。 */
let destroyCalls = 0;
/** 非 null 时 `destroy()` 抛错，模拟 Tauri ACL 拒绝（缺 `core:window:allow-destroy`）。 */
let destroyError: Error | null = null;

/**
 * 触发一次「窗口关闭请求」，供 M-17 的关闭前 flush 用例使用。
 * 返回本次 handler 是否调用了 `preventDefault()`（无 handler 视为未拦截）。
 */
export function emitCloseRequested(): { prevented: boolean } {
  if (!closeRequestedHandler) return { prevented: false };
  let prevented = false;
  closeRequestedHandler({
    preventDefault: () => {
      prevented = true;
      closePreventCount += 1;
    },
  });
  return { prevented };
}

/** 累计 `preventDefault()` 次数。 */
export function closePreventedCount(): number {
  return closePreventCount;
}

/** 累计 `destroy()` 调用次数。 */
export function destroyCallCount(): number {
  return destroyCalls;
}

/** 让下一次（及之后）`destroy()` 抛错；传 null 恢复成功。 */
export function setDestroyError(error: Error | null): void {
  destroyError = error;
}

/** 清空窗口钩子状态（套件之间隔离）。 */
export function resetMockWindow(): void {
  closeRequestedHandler = null;
  closePreventCount = 0;
  destroyCalls = 0;
  destroyError = null;
}

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    label: 'main',
    onCloseRequested: vi.fn(async (handler: CloseRequestedHandler) => {
      closeRequestedHandler = handler;
      return () => {
        if (closeRequestedHandler === handler) closeRequestedHandler = null;
      };
    }),
    destroy: vi.fn(async () => {
      destroyCalls += 1;
      if (destroyError) throw destroyError;
    }),
  }),
}));

/* -------------------------------------------------------------------------- */
/* 对外的 mock 控制面（测试文件从这里 import）                                    */
/* -------------------------------------------------------------------------- */

/**
 * 按命令名注册 invoke 返回值。
 *
 * 两个重载让「函数式返回值」能被上下文类型化 —— 传 `(args) => ...` 时 args
 * 自动是 InvokeArgs，不必在测试里手写 any（否则 tsc --noEmit 会报 TS7006）。
 */
export function mockInvokeCommand(command: string, value: (args: InvokeArgs) => unknown): void;
export function mockInvokeCommand(command: string, value: unknown): void;
export function mockInvokeCommand(command: string, value: unknown): void {
  commandResults.set(command, value);
  commandErrors.delete(command);
}

/** 让某个命令抛错（模拟 sidecar 挂掉 / 文件损坏）。 */
export function mockInvokeError(command: string, error: Error = new Error(`${command} failed`)): void {
  commandErrors.set(command, error);
  commandResults.delete(command);
}

/** 全量接管 invoke。 */
export function setInvokeHandler(
  handler: ((command: string, args?: InvokeArgs) => unknown) | null,
): void {
  invokeHandler = handler;
}

/** 取某个命令的调用历史（含参数）。 */
export function invokeCalls(command: string): InvokeCall[] {
  return recordedCalls.filter((c) => c.command === command);
}

/** 取某个命令的调用次数。 */
export function invokeCount(command: string): number {
  return invokeCalls(command).length;
}

/** 取某个命令最近一次调用的参数。 */
export function lastInvokeArgs(command: string): InvokeArgs {
  const calls = recordedCalls.filter((c) => c.command === command);
  return calls.length ? calls[calls.length - 1].args : undefined;
}

/** 全部 invoke 调用记录（按时间序）。 */
export function allInvokeCalls(): readonly InvokeCall[] {
  return recordedCalls;
}

export function resetInvokeMocks(): void {
  recordedCalls.length = 0;
  commandResults.clear();
  commandErrors.clear();
  invokeHandler = null;
  invokeSpy.mockClear();
  resetMockEvents();
  resetMockWindow();
}

/* -------------------------------------------------------------------------- */
/* 插件层（按需 mock；组件测试里不应触达真实 IPC）                                */
/* -------------------------------------------------------------------------- */

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  save: vi.fn(async () => null),
  message: vi.fn(async () => undefined),
  confirm: vi.fn(async () => false),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: vi.fn(async () => new Uint8Array()),
  writeFile: vi.fn(async () => undefined),
  exists: vi.fn(async () => false),
  mkdir: vi.fn(async () => undefined),
  readDir: vi.fn(async () => []),
  remove: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: class {
    execute() {
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    }
  },
  open: vi.fn(async () => null),
}));

vi.mock('@tauri-apps/plugin-os', () => ({
  platform: vi.fn(async () => 'windows'),
  arch: vi.fn(async () => 'x86_64'),
  type: vi.fn(async () => 'Windows'),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(async () => undefined),
  openPath: vi.fn(async () => undefined),
  revealItemInDir: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn(async () => null),
}));

/* -------------------------------------------------------------------------- */
/* jsdom 补齐：Tauri / 浏览器里存在、jsdom 里缺失的东西                            */
/* -------------------------------------------------------------------------- */

beforeEach(() => {
  resetInvokeMocks();

  // jsdom 没有实现，React 19 的 <img> 事件系统会直接抛 "Not implemented"。
  if (!('matchMedia' in window)) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
  }

  if (!('ResizeObserver' in window)) {
    Object.defineProperty(window, 'ResizeObserver', {
      writable: true,
      value: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    });
  }

  // @tanstack/react-virtual 在 jsdom 里拿不到真实尺寸，直接把所有测量值归零，
  // 否则宫格一行都不会被渲染出来，ThumbnailGrid 的用例会假通过。
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value: () => ({
      width: 1200,
      height: 800,
      top: 0,
      left: 0,
      bottom: 800,
      right: 1200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });

  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 800,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 1200,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
});
