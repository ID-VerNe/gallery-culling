/**
 * 「刚完成升级」的判定与持久化（issue #49-PB）。
 *
 * 为什么需要它：Windows 上 `downloadAndInstall` 拉起安装器后就 `exit(0)`
 * （`tauri-plugin-updater-2.11.0/src/updater.rs:862-876`），安装器负责重启；
 * 但安装器侧也可能失败（issue #49：提权上下文里 `RunAsUser` 返回 1 且静默）。
 * 留一条记录，应用下次启动就能区分：
 * - 当前版本已是目标版本 → 升级成功，给用户一个确认；
 * - 仍是旧版本 → 上次升级没完成，给一条可操作（且不自动消失）的提示。
 *
 * 与 `gc:update:skip` 同一存储层（`localStorage`）与同一理由（见 `src/utils/updateSkip.ts`
 * 顶部说明，issue #98 #103）：默认库已固定在用户 home，故本模块仍保持纯函数 +
 * Storage 注入，不迁 SQLite。
 */

export interface UpdatePendingRecord {
  /** 升级前的版本（排障用，不参与判定）。 */
  fromVersion: string;
  /** 目标版本，判定「装没装上」的唯一依据。 */
  targetVersion: string;
  /** ISO 时间，排障用，不参与判定。 */
  startedAt: string;
}

export const UPDATE_PENDING_KEY = 'gc:update:pending';

/** `none` = 没有待定记录；`completed` = 已到目标版本；`incomplete` = 仍是旧版本。 */
export type PendingUpdateOutcome = 'none' | 'completed' | 'incomplete';

/** 与 `updateSkip.ts` 同一口径：剥掉前导 `v`，大小写不敏感。 */
function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '').toLowerCase();
}

/** 读出待定记录；结构不对或 JSON 损坏一律返回 `null`（当作没发生升级）。 */
export function readPendingRecord(storage: Storage = localStorage): UpdatePendingRecord | null {
  try {
    const raw = storage.getItem(UPDATE_PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<UpdatePendingRecord> | null;
    if (
      !parsed ||
      typeof parsed.fromVersion !== 'string' ||
      typeof parsed.targetVersion !== 'string' ||
      typeof parsed.startedAt !== 'string'
    ) {
      return null;
    }
    return {
      fromVersion: parsed.fromVersion,
      targetVersion: parsed.targetVersion,
      startedAt: parsed.startedAt,
    };
  } catch {
    return null;
  }
}

/** 安装前写入待定记录并返回实际落盘的值。 */
export function writePendingRecord(
  fromVersion: string,
  targetVersion: string,
  now: Date = new Date(),
  storage: Storage = localStorage,
): UpdatePendingRecord {
  const record: UpdatePendingRecord = {
    fromVersion,
    targetVersion,
    startedAt: now.toISOString(),
  };
  storage.setItem(UPDATE_PENDING_KEY, JSON.stringify(record));
  return record;
}

/** 判定结束后清除，避免每次启动重复提示。 */
export function clearPendingRecord(storage: Storage = localStorage): void {
  storage.removeItem(UPDATE_PENDING_KEY);
}

/**
 * 用当前版本判定上次升级的结果。
 *
 * - 没有记录 → `none`；
 * - 当前版本读不出来（`getVersion()` 失败）→ `none`，**不清记录**，等下次能读出来再说；
 * - 版本已到目标 → `completed`；否则 → `incomplete`。
 */
export function classifyPendingUpdate(
  record: UpdatePendingRecord | null,
  currentVersion: string,
): PendingUpdateOutcome {
  if (!record) return 'none';
  if (!currentVersion.trim()) return 'none';
  return normalizeVersion(record.targetVersion) === normalizeVersion(currentVersion)
    ? 'completed'
    : 'incomplete';
}
