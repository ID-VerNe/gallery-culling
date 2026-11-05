/**
 * 「刚完成升级」判定的用例（issue #49-PB）。
 *
 * 每条都盯一个会静默出错的地方：
 * - 判成 completed 但实际没装上 → 用户以为升级成功，实际还在旧版本；
 * - 判成 incomplete 但实际装上了 → 每次启动都报一次假错误；
 * - 坏 JSON 被当成记录 → 启动时凭空多一条提示。
 */
import {
  UPDATE_PENDING_KEY,
  classifyPendingUpdate,
  clearPendingRecord,
  readPendingRecord,
  writePendingRecord,
  type UpdatePendingRecord,
} from './updatePending';

function record(over: Partial<UpdatePendingRecord> = {}): UpdatePendingRecord {
  return {
    fromVersion: '2.0.4',
    targetVersion: '2.0.5',
    startedAt: '2026-11-05T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('updatePending —— 持久化', () => {
  it('写入后能原样读出，并落在 gc:update:pending', () => {
    const written = writePendingRecord('2.0.4', '2.0.5', new Date('2026-11-05T08:00:00.000Z'));
    expect(written.startedAt).toBe('2026-11-05T08:00:00.000Z');
    expect(JSON.parse(localStorage.getItem(UPDATE_PENDING_KEY) ?? 'null')).toEqual(written);
    expect(readPendingRecord()).toEqual(written);
  });

  it('清除后读出为 null', () => {
    writePendingRecord('2.0.4', '2.0.5');
    clearPendingRecord();
    expect(localStorage.getItem(UPDATE_PENDING_KEY)).toBeNull();
    expect(readPendingRecord()).toBeNull();
  });

  it('坏 JSON / 少字段一律当作没有记录', () => {
    localStorage.setItem(UPDATE_PENDING_KEY, '{ not json');
    expect(readPendingRecord()).toBeNull();
    localStorage.setItem(UPDATE_PENDING_KEY, JSON.stringify({ targetVersion: '2.0.5' }));
    expect(readPendingRecord()).toBeNull();
    localStorage.setItem(UPDATE_PENDING_KEY, JSON.stringify(null));
    expect(readPendingRecord()).toBeNull();
  });
});

describe('updatePending —— 结果判定', () => {
  it('没有记录：none', () => {
    expect(classifyPendingUpdate(null, '2.0.5')).toBe('none');
  });

  it('当前版本已是目标版本：completed', () => {
    expect(classifyPendingUpdate(record(), '2.0.5')).toBe('completed');
  });

  it('仍是旧版本：incomplete', () => {
    expect(classifyPendingUpdate(record({ targetVersion: '2.0.6' }), '2.0.5')).toBe('incomplete');
  });

  it('v 前缀与大小写不影响判定', () => {
    expect(classifyPendingUpdate(record({ targetVersion: 'V2.0.5' }), 'v2.0.5')).toBe('completed');
  });

  it('读不出当前版本时不判、也不清记录（none）', () => {
    expect(classifyPendingUpdate(record(), '')).toBe('none');
    expect(classifyPendingUpdate(record(), '   ')).toBe('none');
  });
});
