/**
 * 已精修标记（issue #200）的界面侧契约。
 *
 * 这条需求的验收标准只有一句人话：「一屏扫过去，能看出哪张修过」。所以这里
 * 不测内部字段，只测**用户能看见/听见的东西**：
 *  - 修过的格子必须有一个独立的、可被读屏念出来的「已修」标记；
 *  - 没修过的格子不得有（否则全库亮牌等于没标）；
 *  - 「已修」与旗标/星级/色标**不互斥** —— 一张 picked 的 5 星红标照片修过，
 *    三件事必须同时可见，这是最容易写错的一处（后来者若用「替换」而非「叠加」
 *    实现，这里的断言会立刻红）；
 *  - 格头有「未修/已修」快捷筛选，且它改的是查询串本身（唯一真值）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { resetThumbnailLoaderForTest, ThumbnailGrid } from './ThumbnailGrid';
import { mockInvokeCommand } from '../test/setup';
import { makeGroup } from '../test/factories';
import { parseQuery } from '../utils/queryMatch';
import type { PhotoGroupInfo } from '../types';

const group = (id: string, overrides: Partial<PhotoGroupInfo> = {}) =>
  makeGroup(id, { baseName: id, status: 'COMPLETE', ...overrides });

beforeEach(() => {
  resetThumbnailLoaderForTest();
  mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');
});

const cellFor = (name: string) =>
  screen.getByRole('option', { name: new RegExp(name) });

describe('已精修标记 —— 宫格（issue #200）', () => {
  it('修过的格子有「已修」标记，没修过的没有', () => {
    render(
      <ThumbnailGrid
        groups={[group('DSC04852', { retouched: true }), group('DSC04853')]}
        selectedIndex={0}
        onSelect={() => {}}
      />,
    );

    expect(
      screen.getByRole('img', { name: /已进 Photoshop \/ Camera Raw 精修/ }),
    ).toBeTruthy();
    // 只有一张修过 → 标记只能出现一次。
    expect(
      screen.getAllByRole('img', { name: /已进 Photoshop \/ Camera Raw 精修/ }),
    ).toHaveLength(1);

    // 读屏描述里也要有：只靠视觉色块，视障用户永远不知道这张修过。
    expect(cellFor('DSC04852').getAttribute('aria-label')).toContain('已 PS 精修');
    expect(cellFor('DSC04853').getAttribute('aria-label')).not.toContain('已 PS 精修');
  });

  it('「已修」与 pick / 星级 / 色标叠加显示，而不是互相顶掉', () => {
    render(
      <ThumbnailGrid
        groups={[
          group('DSC04907', { retouched: true, rating: 5, flag: 'pick', label: 'Red' }),
        ]}
        selectedIndex={0}
        onSelect={() => {}}
      />,
    );

    const cell = cellFor('DSC04907');
    const label = cell.getAttribute('aria-label') ?? '';
    expect(label).toContain('5 星');
    expect(label).toContain('已保留');
    expect(label).toContain('色标红');
    expect(label).toContain('已 PS 精修');

    // 视觉上也各占一个位置：旗标在左上、已修在它下面一行。
    const badges = cell.querySelectorAll('[role="img"]');
    expect(badges.length).toBeGreaterThanOrEqual(3);
  });

  it('图例写明「已修」的含义（否则用户不知道黄块是什么）', () => {
    render(
      <ThumbnailGrid
        groups={[group('a', { retouched: true })]}
        selectedIndex={0}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByLabelText(/黄底「已修」表示已进 Photoshop/)).toBeTruthy();
  });
});

describe('已精修筛选 —— 格头快捷入口（issue #200）', () => {
  const setup = (searchQuery = '') => {
    const onSearchQueryChange = vi.fn();
    const onSearchOpenChange = vi.fn();
    render(
      <ThumbnailGrid
        groups={[group('a', { retouched: true }), group('b')]}
        selectedIndex={0}
        onSelect={() => {}}
        searchQuery={searchQuery}
        onSearchQueryChange={onSearchQueryChange}
        onSearchOpenChange={onSearchOpenChange}
      />,
    );
    return { onSearchQueryChange, onSearchOpenChange };
  };

  it('点「未修」往查询串里加 -retouched', () => {
    const { onSearchQueryChange } = setup();
    fireEvent.click(screen.getByRole('button', { name: '只看未精修的照片' }));
    expect(onSearchQueryChange).toHaveBeenCalledWith('-retouched');
    // 产出的查询串必须真的能解析成这个条件，而不是一句没人认得的字面量。
    expect(parseQuery('-retouched').terms[0]).toMatchObject({
      field: 'retouched',
      negated: true,
    });
  });

  it('点「已修」加 retouched / 再点一次撤销', () => {
    const { onSearchQueryChange } = setup('rating>=3');
    fireEvent.click(screen.getByRole('button', { name: '只看已精修的照片' }));
    expect(onSearchQueryChange).toHaveBeenCalledWith('rating>=3 retouched');

    onSearchQueryChange.mockClear();
    // 已激活时再点是「取消」，必须把词条删干净，而不是变成 `retouched -retouched`。
    render(
      <ThumbnailGrid
        groups={[group('a')]}
        selectedIndex={0}
        onSelect={() => {}}
        searchQuery="rating>=3 retouched"
        onSearchQueryChange={onSearchQueryChange}
        onSearchOpenChange={() => {}}
      />,
    );
    const buttons = screen.getAllByRole('button', { name: '只看已精修的照片' });
    fireEvent.click(buttons[buttons.length - 1]);
    expect(onSearchQueryChange).toHaveBeenCalledWith('rating>=3');
  });

  it('两个筛选互斥：从「未修」切到「已修」不会同时留着两个词条', () => {
    const { onSearchQueryChange } = setup('-retouched');
    fireEvent.click(screen.getByRole('button', { name: '只看已精修的照片' }));
    expect(onSearchQueryChange).toHaveBeenCalledWith('retouched');
  });

  it('筛选生效时自动展开搜索框，让用户看得见为什么少了照片', () => {
    const { onSearchOpenChange } = setup();
    fireEvent.click(screen.getByRole('button', { name: '只看未精修的照片' }));
    expect(onSearchOpenChange).toHaveBeenCalledWith(true);
  });
});
