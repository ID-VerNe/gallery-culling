import { api } from '../services/api';
import type { PhotoGroupInfo } from '../types';

/** 视口图片解析结果（三视口同口径）。 */
export interface ResolvedViewportImage {
  /** 最终 `<img src>`；null = 该渲染占位（RAW-only 且 LUMEN 没顶上）。 */
  src: string | null;
  /** 无 JPG 的 RAW 分组（C2：引擎没顶上时也不回落 .NEF 资产 URL）。 */
  rawOnly: boolean;
  /**
   * LUMEN 预览真实命中（url 有效且未 latched 失败）。
   * 调用方据此决定**不**叠加 CSS 调色滤镜 —— LUMEN 渲染已 develop 过一次，
   * 再套滤镜会 develop 两次。
   */
  lumenActive: boolean;
}

/**
 * 解析视口图片源（纯函数，三视口共用的单一真值）。
 *
 * 口径（与抽取前的三个视口逐一核对一致）：
 *  - **JPG 优先**：有 JPG 走 jpg 资产 URL，RAW+JPG 同样（选片心智：速度优先）；
 *  - **RAW-only 只认 LUMEN 真实解码**（C2/M-02）：引擎没顶上（url 为 null 或
 *    已 latched 失败）时 src 必须是 null，由调用方渲染明确占位 —— 回落
 *    .NEF 资产 URL 会永久破图；
 *  - `lumenActive` 与 src 解算分离：有 JPG 时即便传入 lumen url 也不改 src。
 *
 * @param group      当前分组（undefined = 空态，src 为 null）
 * @param lumen      LUMEN 预览结果（只取 url）
 * @param lumenBroken latch：预览曾渲染成功但随后加载失败（陈旧缓存）
 */
export function resolveViewportImage(
  group: PhotoGroupInfo | undefined,
  lumen: { url: string | null },
  lumenBroken: boolean,
): ResolvedViewportImage {
  const hasJpg = Boolean(group?.jpg?.path);
  const hasRaw = Boolean(group?.raw?.path);
  const lumenActive = Boolean(lumen.url && !lumenBroken);
  // RAW-only（无 JPG）分组：引擎不可用时不再回落 .NEF 资产 URL（C2，会永久破图）。
  const rawOnly = !hasJpg && hasRaw;
  const legacySrc = group?.jpg?.path
    ? api.toAssetUrl(group.jpg.path)
    : group?.raw?.path
    ? api.toAssetUrl(group.raw.path)
    : null;
  return {
    src: rawOnly ? (lumenActive ? lumen.url : null) : legacySrc,
    rawOnly,
    lumenActive,
  };
}
