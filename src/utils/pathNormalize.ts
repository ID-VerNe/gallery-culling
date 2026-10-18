/**
 * 路径归一化 —— 判定「两个路径是否指向同一目录」的唯一实现。
 *
 * 为什么必须归一化：`fs::copy(src, src)` 会把原片截断成 0 字节（不可逆）。
 * Windows 下 `D:\shoot\JPG`、`D:/shoot/JPG/`、`d:/shoot/jpg` 是同一个目录，
 * 字符串直接比较会漏判 —— 漏判一次就是原片报废。
 *
 * 不追求与 Rust 侧 `canonicalize` 完全等价（那要碰文件系统、还要处理符号链接），
 * 这里只保证「显然相同的目录被判为相同」；后端仍有强制拒绝作为第二道闸。
 */

/** 统一分隔符为正斜杠、去掉尾部分隔符、统一小写。 */
export const normalizeDir = (p: string): string =>
  p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();

/**
 * 取文件的父目录（**未归一化**，调用方按需再 `normalizeDir`）。
 *
 * 根目录下的文件（如 `/a`）返回 `/`：`lastIndexOf('/')` 为 0 时不能返回空串，
 * 否则会被当成「无父目录」而漏进源目录集合。
 */
export const parentDirOf = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash > 0 ? normalized.slice(0, slash) : normalized;
};

/** 两个路径是否指向同一目录（两侧都归一化后比较）。 */
export const isSameDir = (a: string, b: string): boolean =>
  normalizeDir(a) === normalizeDir(b);

/**
 * 文件路径归一化：统一分隔符 + 小写。
 *
 * 与 `normalizeDir` 的区别：**不去尾部分隔符**。文件路径的尾部分隔符本身就
 * 说明它不是文件（`D:/a/` 是目录），保留它可以让「文件 vs 目录」不会被误判
 * 成同一个东西。
 */
export const normalizeFilePath = (p: string): string =>
  p.replace(/\\/g, '/').toLowerCase();

/**
 * 两个路径是否指向同一个文件（FR-07 判断「源照片是否也在选中里」）。
 *
 * 只做字符串级归一化：不做 canonicalize（会碰文件系统、要处理符号链接）。
 * 这里的用途是**避免对自己重复写盘**，漏判的代价是多写一次同样的值，
 * 远小于误判的代价（把该写的目标跳过），所以保守取「显然相同才算相同」。
 */
export const isSameFile = (a: string, b: string): boolean =>
  normalizeFilePath(a) === normalizeFilePath(b);
