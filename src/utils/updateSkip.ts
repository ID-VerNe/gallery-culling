/**
 * 「跳过此版本」的持久化与判定（issue #43-PB）。
 *
 * 三条约定：
 * - **`version` 是唯一失效键**：远端版本与记录不同就重新提示。不引入 channel
 *   维度——本仓库只有一份 `updater.json`，多一个维度就多一种没有定义答案的语义。
 * - **`endpoint` 只做来源隔离**：换更新地址时旧记录不许抑制新来源。
 * - **坏数据当「没跳过」**：宁可多弹一次，也不许把用户永久静音。
 *
 * 存 `localStorage` 而不是进 SQLite（issue #98 #103）：默认库已固定在用户 home
 * （`src-tauri/src/db.rs:620-659`，`%USERPROFILE%\.galleryculling\`，换安装目录
 * 本就不丢）；但迁进 SQLite 要新增 Tauri 命令并把本模块的纯函数改成异步 IPC，
 * 会破坏「纯函数 + Storage 注入」结构，收益为零，故保持现状（理论可重评估）。
 */

export interface UpdateSkipRecord {
  /** 被跳过的远端版本（唯一失效键）。 */
  version: string;
  /** 更新来源，仅用于来源隔离。 */
  endpoint: string;
  /** ISO 时间，便于以后排障，不参与判定。 */
  skippedAt: string;
}

export const UPDATE_SKIP_KEY = 'gc:update:skip';

/**
 * 镜像 `src-tauri/tauri.conf.json` 的 `plugins.updater.endpoints[0]`。
 * 不许漂移：`src/utils/updateSkip.test.ts` 直接比对配置文件。
 */
export const UPDATE_ENDPOINT =
  'https://raw.githubusercontent.com/ID-VerNe/gallery-culling/master/updater.json';

/** 插件会剥掉前导 `v`（`updater.rs:1514-1521`），比较前统一归一化。 */
function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '');
}

/** 远端版本是否应该触发提示；返回 `false` 表示「该版本已被用户跳过」。 */
export function shouldOfferUpdate(
  remoteVersion: string,
  record: UpdateSkipRecord | null,
  endpoint: string = UPDATE_ENDPOINT,
): boolean {
  if (!record) return true;
  if (record.endpoint !== endpoint) return true;
  return normalizeVersion(record.version) !== normalizeVersion(remoteVersion);
}

/** 读出跳过记录；结构不对或 JSON 损坏一律返回 `null`。 */
export function readSkipRecord(storage: Storage = localStorage): UpdateSkipRecord | null {
  try {
    const raw = storage.getItem(UPDATE_SKIP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<UpdateSkipRecord> | null;
    if (
      !parsed ||
      typeof parsed.version !== 'string' ||
      typeof parsed.endpoint !== 'string' ||
      typeof parsed.skippedAt !== 'string'
    ) {
      return null;
    }
    return {
      version: parsed.version,
      endpoint: parsed.endpoint,
      skippedAt: parsed.skippedAt,
    };
  } catch {
    return null;
  }
}

/** 写入跳过记录并返回实际落盘的值（供调用方回填 UI 状态）。 */
export function writeSkipRecord(
  version: string,
  endpoint: string = UPDATE_ENDPOINT,
  now: Date = new Date(),
  storage: Storage = localStorage,
): UpdateSkipRecord {
  const record: UpdateSkipRecord = {
    version,
    endpoint,
    skippedAt: now.toISOString(),
  };
  storage.setItem(UPDATE_SKIP_KEY, JSON.stringify(record));
  return record;
}

/** 撤销跳过（设置「关于」段的「恢复提示」入口）。 */
export function clearSkipRecord(storage: Storage = localStorage): void {
  storage.removeItem(UPDATE_SKIP_KEY);
}
