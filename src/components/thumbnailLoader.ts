import { api } from '../services/api';

/**
 * 宫格缩略图请求宽度：**独立产品值**，恒为 200（issue #133 裁决）。
 *
 * 与后端/前端默认宽度（`DEFAULT_THUMBNAIL_WIDTH`）数值巧合一致，但语义独立：
 * 宫格格高固定（`GRID_CELL_HEIGHT`），只关心「够小格看清」的固定下限，
 * 不读设置页的缩略图宽度（100–600）。若将来要接跟随设置，须另提 feat issue
 * 并显式拆除 `ThumbnailGrid.test.tsx` 的「恒为 200」墓碑，不得静默改值。
 */
export const GRID_THUMB_WIDTH = 200;

/**
 * 缩略图请求的进程内「并发去重 + 结果缓存」。
 *
 * 每个进入虚拟窗口的格子都在挂载时请求缩略图；快速滚动/来回滚动会大量卸载与重挂，
 * 同一文件被反复请求。这把「同一路径 + 同宽度」收敛成一个 Promise：
 *  - **并发命中**：多个格子共享同一个 inflight Promise，只发一次 IPC；
 *  - **完成命中**：结果留在 cache，滚回来直接命中，不再发 IPC。
 *
 * 失败**不缓存**，并从 inflight 移除 —— 否则一次磁盘抖动会让该图永远空白、无法重试。
 * 作用域为模块级单例（issue #107）：跨 `ThumbnailGrid` 卸载存活，随进程结束释放。
 * 陈旧风险由缓存键承担：同路径同宽度即同图，路径不变则缓存仍对（与实例级
 * 「滚回来命中」同口径，只是命中的时间跨度从实例延长到进程）。
 *
 * 键用 `宽度|路径`：`group.jpg?.path` / `raw.path` 稳定，适合做键（见 §4 (b)）。
 */
export interface ThumbnailLoader {
  /**
   * 相机内嵌缩略图（无内嵌时后端退回整图缩放），resolve 已 `convertFileSrc`
   * 的 URL。宫格**只走这一条**（issue #192：不再为缩略图付 LUMEN 真实解码）。
   */
  thumbnail: (path: string, width: number) => Promise<string>;
}

/** 通用去重器：命中缓存直接返回；命中 inflight 复用；否则发起并登记。 */
function dedupeAsync<T>(
  cache: Map<string, T>,
  inflight: Map<string, Promise<T>>,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const cached = cache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = run().then(
    (value) => {
      inflight.delete(key);
      cache.set(key, value);
      return value;
    },
    (err) => {
      // 失败不缓存：移除 inflight 以便后续重挂能重试。
      inflight.delete(key);
      throw err;
    },
  );
  inflight.set(key, p);
  return p;
}

/** 模块级单例（issue #107）：懒初始化，进程内共享。 */
let sharedLoader: ThumbnailLoader | null = null;

export function getSharedThumbnailLoader(): ThumbnailLoader {
  if (!sharedLoader) sharedLoader = createThumbnailLoader();
  return sharedLoader;
}

/**
 * 仅测试用：清掉模块级缓存，让每个用例从空缓存起测（`invokeCount` 按用例
 * 复位后，模块级缓存会跨用例残留 — 用唯一路径可避，但共用路径的用例需要它）。
 * 生产代码不得调用。
 */
export function resetThumbnailLoaderForTest(): void {
  sharedLoader = null;
}

function createThumbnailLoader(): ThumbnailLoader {
  const thumbCache = new Map<string, string>();
  const thumbInflight = new Map<string, Promise<string>>();

  return {
    thumbnail: (path, width) =>
      dedupeAsync(thumbCache, thumbInflight, `${width}|${path}`, () =>
        api.getThumbnail(path, width),
      ),
  };
}
