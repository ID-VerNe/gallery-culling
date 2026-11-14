/**
 * T3 缩略图探键读数解析纯函数单测（issue #190 缺陷 B）。
 *
 * 真窗口 e2e 不进 CI（manual 档），本文件在没有桌面会话的阶段把解析逻辑钉住：
 * 路径 / 文件名含空格、旧全角括号形式、中文标点三类输入都必须解出 ret；
 * 解析改回 `\S+` 时「读数带空格」「中文标点 + 空格」两例必须红。
 *
 * 纯函数在 `e2e/lib/thumbReading.mjs`（node 侧编排器共用，不在浏览器 bundle 里）。
 */
import { describe, expect, it } from 'vitest';
import { parseT3Reading } from '../../e2e/lib/thumbReading.mjs';

const line = (text) => `001 [1.0s] >>> ${text}`;

describe('T3 读数解析（issue #190 缺陷 B）', () => {
  it('新结构化形式：alt / ret 键值对逐字解出', () => {
    const r = parseT3Reading(
      line('读数 T3 alt=d:/e2e/.tmp/fixtures/jpg/IMG_001.jpg ret=abc_def.webp'),
    );
    expect(r).toEqual({
      alt: 'd:/e2e/.tmp/fixtures/jpg/IMG_001.jpg',
      ret: 'abc_def.webp',
    });
  });

  it('读数带空格：alt 路径含空格不截断（变异：改回 \\S+ 必须红）', () => {
    const r = parseT3Reading(
      line('读数 T3 alt=C:\\Users\\A B\\IMG_001.jpg ret=abc_def.webp'),
    );
    expect(r).toEqual({ alt: 'C:\\Users\\A B\\IMG_001.jpg', ret: 'abc_def.webp' });
  });

  it('全角括号：旧形式 `异写法（<alt>）直调返回 <ret>` 仍兼容', () => {
    const r = parseT3Reading(
      line('读数 T3 异写法（d:/e2e/.tmp/fixtures/jpg/IMG_001.jpg）直调返回 abc_def.webp'),
    );
    expect(r).toEqual({
      alt: 'd:/e2e/.tmp/fixtures/jpg/IMG_001.jpg',
      ret: 'abc_def.webp',
    });
  });

  it('读数含中文标点：ret 带中文与空格整段保留，不被截断', () => {
    const r = parseT3Reading(
      line('读数 T3 alt=D:\\照片 库\\IMG_001.jpg ret=照片 001，副.webp'),
    );
    expect(r).toEqual({ alt: 'D:\\照片 库\\IMG_001.jpg', ret: '照片 001，副.webp' });
  });

  it('日志里没有 T3 读数行 → null（T7 期望值不被旧值污染）', () => {
    expect(parseT3Reading('001 [1.0s] >>> 读数 T1 冷启动 IPC=12 可见格子=12')).toBeNull();
    expect(parseT3Reading('')).toBeNull();
    expect(parseT3Reading(null)).toBeNull();
  });

  it('多行日志：只取含「读数 T3」的那一行', () => {
    const log = [
      line('读数 T1 冷启动 IPC=12 可见格子=12'),
      line('读数 T3 alt=d:/fixtures/IMG_001.jpg ret=abc_def.webp'),
      line('读数 T4 切面板回来 IPC=12（切前 12）格子=12'),
    ].join('\n');
    expect(parseT3Reading(log)?.ret).toBe('abc_def.webp');
  });
});
