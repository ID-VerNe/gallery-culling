/**
 * 真实 RAW 自动探测（issue #212）。
 *
 * `detail-1to1` 必须用真实 RAW：夹具里的 `.ARW` 是 JPEG 改后缀，photo.export
 * 解不出图，1:1 永远走不到。但此前编排器要求调用者手写 `--raw-dir=<目录>/rawonly`，
 * 等于把场景绑在一个绝对路径上；本机 `Pictures/Camera Roll` 明明有 911 张 ARW，
 * 无参数运行仍然 exit 2。
 *
 * 本模块只做三件事：
 *   1. 按文件头 magic + 最小体积门槛判断「这是不是真相机 RAW」，
 *      把 JPEG/PNG 改后缀的假 RAW 排除掉；
 *   2. 从 `os.homedir()/Pictures/Camera Roll` 递归找真实 RAW 文件；
 *      选中的文件会硬链接到 `e2e/.tmp/realraw`，源目录里的同 stem JPG
 *      不会被带过去，所以扫描时仍是 RAW-only 组，1:1 能走到真 RAW；
 *   3. 把选中的 2 张硬链接到 `e2e/.tmp/realraw`（跨卷/无权限时回落复制），
 *      让扫描目录只含这两张，场景稳定且不用扫整个 Camera Roll。
 *
 * 不写死任何绝对目录：根来自 `os.homedir()`，允许 `GALLERY_REAL_RAW_DIR` 或
 * `--raw-dir` 覆盖。CLI `--probe` 只打印候选，不建目录，便于人工核对。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 相机 RAW 常见扩展名（小写比较）。 */
export const RAW_EXTENSIONS = /\.(arw|nef|cr2|cr3|dng|raf|orf|rw2)$/i;

/**
 * 真实 RAW 的体积门槛：1 MiB。
 *
 * 夹具的 JPEG 改后缀只有约 1.3 KB；真实相机 RAW 通常 10–60 MB。门槛不是
 * 「文件格式」判据，只是把明显不可能的小文件先挡掉，最终仍以 magic 为准。
 */
export const MIN_REAL_RAW_BYTES = 1 << 20;

/** TIFF 系（ARW/NEF/CR2/DNG）与各自容器的文件头特征。 */
function hasRawMagic(buf) {
  const b = buf;
  const tiffLE = b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00; // II*\0
  const tiffBE = b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a; // MM\0*
  const cr3 = b.slice(4, 8).toString('ascii') === 'ftyp' && b.slice(8, 12).toString('ascii') === 'crx ';
  const raf = b.slice(0, 8).toString('ascii') === 'FUJIFILM';
  const orf =
    (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x52 && b[3] === 0x4f) || // IIRO
    (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x4f && b[3] === 0x52); // MMOR
  const rw2 = b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x55 && b[3] === 0x00; // IIU\0
  return { tiffLE, tiffBE, cr3, raf, orf, rw2, any: tiffLE || tiffBE || cr3 || raf || orf || rw2 };
}

/** 读文件前 16 字节；失败返回 null（权限/消失都按「不是 RAW」处理）。 */
function readHeader(file, length = 16) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, 0);
    if (n < 4) return null;
    return buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // 关不上不影响判定；下一次探测会重新打开。
      }
    }
  }
}

/** 是否是真实 RAW（扩展名 + 体积 + magic 三者同时成立）。 */
export function isRealRawFile(file) {
  if (!RAW_EXTENSIONS.test(file)) return false;
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return false;
  }
  if (!st.isFile() || st.size < MIN_REAL_RAW_BYTES) return false;
  const buf = readHeader(file);
  if (!buf) return false;
  return hasRawMagic(buf).any;
}

/** 列一个目录（不递归）里的真实 RAW 文件，按文件名排序。 */
export function listRealRawInDir(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && RAW_EXTENSIONS.test(e.name))
    .map((e) => path.join(dir, e.name))
    .filter((file) => isRealRawFile(file))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

/** 默认扫描根：环境变量优先，其次 `~/Pictures/Camera Roll` 与 `~/Pictures`。 */
export function defaultRawRoots() {
  const home = os.homedir();
  return [
    process.env.GALLERY_REAL_RAW_DIR,
    path.join(home, 'Pictures', 'Camera Roll'),
    path.join(home, 'Pictures'),
  ].filter(Boolean);
}

const SKIP_DIRS = new Set(['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information']);

/**
 * 递归找第一个含 ≥2 张真实 RAW 的目录。
 *
 * 按根的顺序**逐棵深度优先**：第一个根（默认 Camera Roll）整棵扫完再换下一个，
 * 不会被 `~/Pictures` 根目录里零散的 RAW 抢在前面。深度上限 4（Camera Roll 的
 * `日期/子主题/` 两层已足够）；软链接目录不跟进，避免环。
 */
export function discoverRealRawDir(roots = defaultRawRoots(), maxDepth = 4) {
  const seen = new Set();

  function scanTree(dir, depth) {
    if (seen.has(dir)) return null;
    seen.add(dir);
    const files = listRealRawInDir(dir);
    if (files.length >= 2) return { ok: true, sourceDir: dir, files };
    if (depth >= maxDepth) return null;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    const subdirs = entries
      .filter(
        (e) =>
          e.isDirectory() &&
          !e.isSymbolicLink() &&
          !SKIP_DIRS.has(e.name) &&
          !e.name.startsWith('.'),
      )
      .map((e) => path.join(dir, e.name))
      .sort((a, b) => a.localeCompare(b));
    for (const sub of subdirs) {
      const hit = scanTree(sub, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  for (const root of roots) {
    if (!root) continue;
    let resolved;
    try {
      if (!fs.statSync(root).isDirectory()) continue;
      resolved = path.resolve(root);
    } catch {
      continue;
    }
    const hit = scanTree(resolved, 0);
    if (hit) return hit;
  }
  return {
    ok: false,
    message: `未找到 ≥2 张真实 RAW：已扫描 ${roots.filter(Boolean).join('、')}。` +
      `可用 GALLERY_REAL_RAW_DIR 或 --raw-dir 指定目录。`,
  };
}

/**
 * 为 `detail-1to1` 准备一个只含两张真实 RAW 的目录。
 *
 * 显式目录优先看 `<dir>/rawonly/`（兼容旧用法），其次看目录本身；都没有再
 * 递归找。自动模式从 `roots` 递归发现。选中文件硬链接到 `dest`；跨卷或
 * 文件系统不支持硬链接时回落 `copyFileSync`（两张 25MB 量级，可接受）。
 */
export function prepareDetailRaw({
  explicitDir = '',
  roots = defaultRawRoots(),
  dest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.tmp', 'realraw'),
} = {}) {
  let found = null;
  if (explicitDir) {
    const candidates = [path.join(explicitDir, 'rawonly'), explicitDir];
    for (const candidate of candidates) {
      try {
        if (!fs.statSync(candidate).isDirectory()) continue;
      } catch {
        continue;
      }
      const files = listRealRawInDir(candidate);
      if (files.length >= 2) {
        found = { ok: true, sourceDir: candidate, files };
        break;
      }
    }
    if (!found) {
      found = discoverRealRawDir([explicitDir]);
    }
  } else {
    found = discoverRealRawDir(roots);
  }

  if (!found.ok) {
    const suffix = explicitDir ? `（显式目录：${explicitDir}）` : '';
    return { ok: false, message: `${found.message}${suffix}` };
  }

  const selected = found.files.slice(0, 2);
  try {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
  } catch (err) {
    return { ok: false, message: `无法重建真实 RAW 目录 ${dest}：${err.message}` };
  }

  for (const file of selected) {
    const target = path.join(dest, path.basename(file));
    try {
      fs.linkSync(file, target);
    } catch {
      try {
        fs.copyFileSync(file, target);
      } catch (err) {
        return { ok: false, message: `无法准备真实 RAW ${file} → ${target}：${err.message}` };
      }
    }
  }

  return {
    ok: true,
    dir: dest,
    names: selected.map((f) => path.basename(f, path.extname(f))),
    sourceDir: found.sourceDir,
    sourceFiles: selected,
  };
}

// `--probe`：只打印候选，不写盘。用于人工核对「会自动挑哪两张」。
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const roots = [process.argv.find((a) => a.startsWith('--raw-dir='))?.split('=')[1],
    ...defaultRawRoots()].filter(Boolean);
  const found = discoverRealRawDir(roots);
  if (!found.ok) {
    console.error(found.message);
    process.exit(2);
  }
  console.log(`source=${found.sourceDir}`);
  for (const file of found.files.slice(0, 2)) {
    console.log(`- ${path.basename(file)} ${fs.statSync(file).size} bytes`);
  }
}
