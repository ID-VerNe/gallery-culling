/**
 * 生成确定性测试素材（每次运行前重建，避免上一轮测试的写入污染下一轮）。
 *
 * 产出：
 *   <root>/JPG/IMG_001..012.jpg   真 JPEG
 *   <root>/JPG/IMG_001..007.xmp   真 XMP sidecar，覆盖全部评级/旗标分支
 *   <root>/RAW/IMG_001|002|004.ARW   与 JPG 同 stem（应配对成 JPG+RAW）
 *   <root>/RAW/RAW_ONLY_009.ARW      只有 RAW 无 JPG（应触发 C2 占位规则）
 *   <root>/OUT/                       批量导出目标
 *
 * RAW 说明：这里写入的是「JPEG 字节 + .ARW 扩展名」的合成文件。e2e 关心的是
 * **配对与占位规则**（按扩展名/词干分组、C2 的 RAW-only 无预览），
 * 而真正解码 NEF 需要 LUMEN sidecar —— 那是另外的 opt-in 套件，不在本目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_ROOT = path.resolve(HERE, '..', '.tmp', 'fixtures');
export const JPG = path.join(FIXTURE_ROOT, 'JPG');
export const RAW = path.join(FIXTURE_ROOT, 'RAW');
export const OUT = path.join(FIXTURE_ROOT, 'OUT');

/** 64x48 的合法 JPEG（base64）。够小，直接内嵌，不依赖 ImageMagick。 */
/** 480x360 的合法 JPEG（base64）。够小可直接内嵌，不依赖 ImageMagick。
 *  尺寸是刻意的：缩略图管线要做「取内嵌预览 -> 否则按宽度缩放」，
 *  用 64x48 的迷你图会让缩放路径没有意义（甚至直接判失败）。 */
const TINY_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAFoAeADASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAABv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AACKVwAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/9k=';

const XPACKET_UUID = 'W5M0MpCehiHzreSzNTczkc9d';

/** 造一份带本方 rdf:Description 的 sidecar（属性声明用真换行，可被标准 XML 解析器读）。 */
function sidecar({ rating = 0, label, lens, focal, aperture, tone } = {}) {
  const crs = tone
    ? [
        tone.exposure != null && `      <crs:Exposure2012>${tone.exposure >= 0 ? '+' : ''}${tone.exposure.toFixed(2)}</crs:Exposure2012>`,
        tone.highlights != null && `      <crs:Highlights2012>${tone.highlights >= 0 ? '+' : ''}${Math.round(tone.highlights)}</crs:Highlights2012>`,
        tone.shadows != null && `      <crs:Shadows2012>${tone.shadows >= 0 ? '+' : ''}${Math.round(tone.shadows)}</crs:Shadows2012>`,
        tone.temperature != null && `      <crs:Temperature2012>${tone.temperature >= 0 ? '+' : ''}${Math.round(tone.temperature)}</crs:Temperature2012>`,
        tone.contrast != null && `      <crs:Contrast2012>${tone.contrast >= 0 ? '+' : ''}${Math.round(tone.contrast)}</crs:Contrast2012>`,
      ]
        .filter(Boolean)
        .join('\n') + '\n'
    : '';
  const lensTags = lens
    ? `      <aux:Lens>${lens}</aux:Lens>\n      <aux:LensModel>${lens}</aux:LensModel>\n`
    : '';
  const focalTags = focal ? `      <aux:FocalLength>${focal}</aux:FocalLength>\n` : '';
  const apertureTags = aperture ? `      <aux:FNumber>${aperture}</aux:FNumber>\n` : '';

  return `<?xpacket begin="﻿" id="${XPACKET_UUID}"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="GalleryCulling">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
        xmlns:xmp="http://ns.adobe.com/xap/1.0/"
        xmlns:aux="http://ns.adobe.com/exif/1.0/aux/"
        xmlns:exif="http://ns.adobe.com/exif/1.0/"
        xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/">
      <xmp:Rating>${rating}</xmp:Rating>
${label ? `      <xmp:Label>${label}</xmp:Label>\n` : ''}${lensTags}${focalTags}${apertureTags}${crs}    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
`;
}

/**
 * 每个 sidecar 对应的期望态。测试脚本直接 import 这张表，
 * 避免「断言里的期望值」和「素材里的真值」各写一份而漂移。
 */
export const EXPECTED = {
  IMG_001: { rating: 5, flag: 'pick' },
  IMG_002: { rating: 3, flag: 'none' },
  IMG_003: { rating: 0, flag: 'reject' }, // Rating=-1（Lightroom / LUMEN 约定）
  IMG_004: { rating: 4, flag: 'none' }, // 带 tone，供调色套件用
  IMG_005: { rating: 0, flag: 'reject' }, // Label=Red（历史约定，另一条分支）
  IMG_006: { rating: 0, flag: 'pick' },
  IMG_007: { rating: 0, flag: 'none' }, // Label=None（边界：不得读成 reject）
  IMG_008: { rating: 0, flag: 'none' }, // 干净照片，评级套件在它身上写
  IMG_009: { rating: 0, flag: 'none' },
  IMG_010: { rating: 0, flag: 'none' },
  IMG_011: { rating: 0, flag: 'none' },
  IMG_012: { rating: 0, flag: 'none' },
  RAW_ONLY_009: { rating: 0, flag: 'none' },
};

/** JPG + RAW 同 stem 的三组（配对后应为 JPG+RAW）。 */
export const PAIRED_STEMS = ['IMG_001', 'IMG_002', 'IMG_004'];
export const RAW_ONLY_STEM = 'RAW_ONLY_009';
export const ALL_STEMS = Object.keys(EXPECTED);

const TONE_FOR_004 = {
  exposure: 0.65,
  highlights: -20,
  shadows: 15,
  temperature: 30,
  contrast: 10,
};

export function generateFixtures(root = FIXTURE_ROOT) {
  const jpgDir = path.join(root, 'JPG');
  const rawDir = path.join(root, 'RAW');
  const outDir = path.join(root, 'OUT');

  // 每次重建：测试会就地写 rating/tone/export，不清就会互相污染
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(jpgDir, { recursive: true });
  fs.mkdirSync(rawDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const jpeg = Buffer.from(TINY_JPEG_B64, 'base64');

  // 12 张 JPG（IMG_008 不带 sidecar，留给评级套件做「全新写入」）
  for (let i = 1; i <= 12; i++) {
    const stem = `IMG_${String(i).padStart(3, '0')}`;
    fs.writeFileSync(path.join(jpgDir, `${stem}.jpg`), jpeg);
  }

  // 7 个 sidecar，覆盖：pick / reject(Rating=-1) / reject(Label=Red) /
  // 普通星级 / 带 tone / Label=None 边界
  const sides = {
    IMG_001: { rating: 5, label: 'Green' },
    IMG_002: { rating: 3 },
    IMG_003: { rating: -1 },
    IMG_004: {
      rating: 4,
      lens: 'Voigtlander 50mm F2 APO',
      focal: '50mm',
      aperture: '2.0',
      tone: TONE_FOR_004,
    },
    IMG_005: { rating: 0, label: 'Red' },
    IMG_006: { rating: 0, label: 'Green' },
    IMG_007: { rating: 0, label: 'None' },
  };
  for (const [stem, meta] of Object.entries(sides)) {
    fs.writeFileSync(path.join(jpgDir, `${stem}.xmp`), sidecar(meta), 'utf8');
  }

  // RAW（合成：JPEG 字节 + .ARW 扩展名，见文件头说明）
  for (const stem of PAIRED_STEMS) {
    fs.writeFileSync(path.join(rawDir, `${stem}.ARW`), jpeg);
  }
  fs.writeFileSync(path.join(rawDir, `${RAW_ONLY_STEM}.ARW`), jpeg);

  return { root, jpgDir, rawDir, outDir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = generateFixtures();
  const n = fs.readdirSync(r.jpgDir).length;
  console.log('fixtures generated -> ' + r.root);
  console.log('  JPG/' + n + ' files, RAW/' + fs.readdirSync(r.rawDir).length + ' files');
}
