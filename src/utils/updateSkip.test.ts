/**
 * 「跳过此版本」持久化的纯逻辑用例。
 *
 * 口径（issue #43-PB）：
 * - `version` 是**唯一失效键**：远端版本与记录里的不同（不论更高还是更低）就重新提示；
 * - `endpoint` 只做**来源隔离**：换了更新地址时，旧记录不许抑制新来源；
 * - 坏数据一律当「没有跳过」，宁可多弹一次，也不许把用户永久静音。
 */
import {
  UPDATE_ENDPOINT,
  UPDATE_SKIP_KEY,
  clearSkipRecord,
  readSkipRecord,
  shouldOfferUpdate,
  writeSkipRecord,
} from './updateSkip';
import tauriConf from '../../src-tauri/tauri.conf.json';

beforeEach(() => {
  localStorage.clear();
});

describe('shouldOfferUpdate —— 版本与来源判定', () => {
  it('没有跳过记录时照常提示', () => {
    expect(shouldOfferUpdate('2.0.5', null, UPDATE_ENDPOINT)).toBe(true);
  });

  it('同版本 + 同来源：不再提示', () => {
    const record = writeSkipRecord('2.0.6');
    expect(shouldOfferUpdate('2.0.6', record, UPDATE_ENDPOINT)).toBe(false);
  });

  it('远端带前导 v 与记录等价（插件会剥掉 v，比较必须归一化）', () => {
    const record = writeSkipRecord('v2.0.6');
    expect(shouldOfferUpdate('2.0.6', record, UPDATE_ENDPOINT)).toBe(false);
  });

  it('远端版本更高：重新提示（跳过只对当时那个版本有效）', () => {
    const record = writeSkipRecord('2.0.6');
    expect(shouldOfferUpdate('2.0.7', record, UPDATE_ENDPOINT)).toBe(true);
  });

  it('远端版本更低（降级/回滚）：也重新提示，不沿用旧标记', () => {
    const record = writeSkipRecord('2.0.6');
    expect(shouldOfferUpdate('2.0.5', record, UPDATE_ENDPOINT)).toBe(true);
  });

  it('endpoint 变化：记录不跨来源生效', () => {
    const record = writeSkipRecord('2.0.6', 'https://example.invalid/updater.json');
    expect(shouldOfferUpdate('2.0.6', record, UPDATE_ENDPOINT)).toBe(true);
  });
});

describe('readSkipRecord —— 坏数据兜底', () => {
  it('没有键时返回 null', () => {
    expect(readSkipRecord()).toBeNull();
  });

  it('JSON 损坏时返回 null，而不是抛错', () => {
    localStorage.setItem(UPDATE_SKIP_KEY, '{not json');
    expect(readSkipRecord()).toBeNull();
  });

  it('结构缺字段时返回 null', () => {
    localStorage.setItem(UPDATE_SKIP_KEY, JSON.stringify({ version: '2.0.6' }));
    expect(readSkipRecord()).toBeNull();
  });

  it('写在 localStorage 的值包含 version / endpoint / skippedAt', () => {
    const before = new Date('2026-11-04T00:00:00.000Z');
    const record = writeSkipRecord('2.0.6', UPDATE_ENDPOINT, before);
    expect(record).toEqual({
      version: '2.0.6',
      endpoint: UPDATE_ENDPOINT,
      skippedAt: '2026-11-04T00:00:00.000Z',
    });
    expect(JSON.parse(localStorage.getItem(UPDATE_SKIP_KEY) ?? '{}')).toEqual(record);
  });

  it('clearSkipRecord 删掉记录', () => {
    writeSkipRecord('2.0.6');
    clearSkipRecord();
    expect(readSkipRecord()).toBeNull();
  });
});

describe('UPDATE_ENDPOINT —— 与 tauri.conf.json 不许漂移', () => {
  it('前端常量与 plugins.updater.endpoints[0] 一致', () => {
    expect(UPDATE_ENDPOINT).toBe(tauriConf.plugins.updater.endpoints[0]);
  });
});
