/**
 * 查询式筛选：`parseQuery` + `matchesQuery`（FR-06）。
 *
 * 移植 LUMEN 的字段查询语法（`catalog.py:269-336`），并按本项目的 EXIF 模型
 * 扩展六个摄影参数（iso / camera / lens / aperture / shutter / focal）——
 * 那六个字段 LUMEN 没有，属于差异化。
 *
 * 三条设计原则：
 *
 * 1. **裸词是文件名子串**。升级前搜索框就是 `baseName.includes(q)`，老用户
 *    输入 `DSC0` 的肌肉记忆必须继续工作。因此裸词不当作「未知字段」，也不
 *    当作 glob（`DSC0` 的 glob 只匹配完全相等，语义会悄悄变严）。
 *
 * 2. **解析出错不清空宫格**。`matchesParsedQuery` 在有 errors 时直接放行，
 *    错误只作为提示渲染。用户拼错一个字段就整屏变空，比不支持语法更糟。
 *
 * 3. **未完成输入不算错**。敲到 `iso:` 时值是空的，此时既不该报错（用户还
 *    在打字），也不该生效（`iso:` 若按「等于空」求值会筛掉全部）。放进
 *    `pending` 供 UI 显示「输入中」。
 */
import type { PhotoGroupInfo } from '../types';

export type QueryField =
  | 'rating'
  | 'flag'
  | 'label'
  | 'name'
  | 'ext'
  | 'folder'
  | 'edited'
  | 'iso'
  | 'camera'
  | 'lens'
  | 'aperture'
  | 'shutter'
  | 'focal';

export type QueryOp = '=' | '>=' | '<=' | '>' | '<' | 'contains' | 'glob';

export interface QueryTerm {
  field: QueryField;
  op: QueryOp;
  /** 数值字段是 number；枚举/文本是归一化后的小写字符串；edited 是 true。 */
  value: string | number | boolean;
  negated: boolean;
  /** 原始词条（含 `-` 前缀），用于 UI 回显与错误定位。 */
  raw: string;
}

export interface QueryParseResult {
  /** 有效词条；全部满足才通过（AND）。 */
  terms: QueryTerm[];
  /** 人类可读的错误，已带示例。非空时 `matchesParsedQuery` 放行全部。 */
  errors: string[];
  /** 值还空着的词条原文（用户正在输入）。 */
  pending: string[];
}

type FieldKind = 'number' | 'text' | 'enum' | 'bool';

interface FieldSpec {
  kind: FieldKind;
  /** 枚举可选值。 */
  values?: readonly string[];
  /** 报错时展示的可用示例。 */
  example: string;
}

/**
 * 字段表。`ext` 刻意不列枚举值：相机与厂商的扩展名是开放集合
 * （ARW/NEF/CR3/RAF/ORF/RW2/DNG…），列不全反而会拦住合法输入。
 */
const FIELDS: Record<QueryField, FieldSpec> = {
  rating: { kind: 'number', example: 'rating>=3' },
  flag: { kind: 'enum', values: ['pick', 'reject', 'none'], example: 'flag:pick' },
  label: {
    kind: 'enum',
    values: ['red', 'yellow', 'green', 'blue', 'purple', 'none'],
    example: 'label:red',
  },
  name: { kind: 'text', example: 'name:DSC0*' },
  ext: { kind: 'text', example: 'ext:arw' },
  folder: { kind: 'text', example: 'folder:2024' },
  edited: { kind: 'bool', example: 'edited' },
  iso: { kind: 'number', example: 'iso>=3200' },
  camera: { kind: 'text', example: 'camera:sony' },
  lens: { kind: 'text', example: 'lens:85mm' },
  aperture: { kind: 'number', example: 'aperture>=2.8' },
  shutter: { kind: 'number', example: 'shutter<=1/500' },
  focal: { kind: 'number', example: 'focal>=85' },
};

const FIELD_NAMES = Object.keys(FIELDS) as QueryField[];

/**
 * 首次打开搜索框时展示的示例（点击即填入）。
 *
 * 语法门槛是这条需求的主要风险：摄影师不想学查询语言。三个例子分别演示
 * 「数值比较」「枚举」「取反」——覆盖了最常用的三种形态，而不是把字段表
 * 全列一遍。
 */
export const QUERY_EXAMPLES: readonly string[] = [
  'rating>=3',
  'label:red',
  '-flag:reject',
];

/** 裸词简写：对齐 LUMEN 的 `picked` / `rejected` / `unflagged` / `edited`。 */
const SHORTHANDS: Record<string, QueryField | 'flag-pick' | 'flag-reject' | 'flag-none'> = {
  picked: 'flag-pick',
  rejected: 'flag-reject',
  unflagged: 'flag-none',
  edited: 'edited',
};

/** 字段名 + 比较符 + 值。`:` 与 `=` 都表示「等于」。 */
const TERM_RE = /^([a-zA-Z]+)(>=|<=|>|<|=|:)(.*)$/;

const AVAILABLE_FIELDS = FIELD_NAMES.join(' / ');

function isQueryField(name: string): name is QueryField {
  return Object.prototype.hasOwnProperty.call(FIELDS, name);
}

/**
 * 数值字段的宽容解析：EXIF 里存的是带单位的字符串（`f/2.8`、`1/1000`、
 * `85mm`、`6400`），用户也未必照抄格式。解析不出数字返回 null，由调用方
 * 决定报错还是当作未命中。
 */
function parseFieldNumber(field: QueryField, raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;

  if (field === 'shutter') {
    // 快门以「秒」为唯一量纲：1/500 → 0.002，这样「更快」就是「数值更小」，
    // 用户输入 `shutter<=1/500` 的直觉才成立。直接写 0.002 也接受。
    const frac = /^1\/(\d+(?:\.\d+)?)$/.exec(s);
    if (frac) return 1 / Number(frac[1]);
    const n = Number(s.replace(/s$/i, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // 光圈可能写成 f/2.8 或 f2.8；焦距可能带 mm；ISO 可能带前导 ISO。
  const cleaned = s
    .replace(/^iso\s*/i, '')
    .replace(/^f\/?/i, '')
    .replace(/mm$/i, '')
    .replace(/s$/i, '')
    .trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** glob → 正则，`*` 任意串、`?` 单字符，其余字符按字面量。 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`);
}

/**
 * glob 正则缓存。`name:DSC0*` 在 10k 张上会被求值 10k 次，每次新建 RegExp
 * 是这一层最容易踩的性能坑；pattern 数量等于词条数，缓存不会增长。
 */
const globCache = new Map<string, RegExp>();

function cachedGlob(pattern: string): RegExp {
  let re = globCache.get(pattern);
  if (!re) {
    re = globToRegExp(pattern);
    globCache.set(pattern, re);
  }
  return re;
}

/** 解析一条查询串。空串返回空词条（恒真）。 */
export function parseQuery(input: string): QueryParseResult {
  const terms: QueryTerm[] = [];
  const errors: string[] = [];
  const pending: string[] = [];

  const tokens = input.trim().split(/\s+/).filter(Boolean);
  for (const raw of tokens) {
    const negated = raw.length > 1 && raw.startsWith('-');
    const body = negated ? raw.slice(1) : raw;
    if (!body) continue;

    const m = TERM_RE.exec(body);
    if (!m) {
      const lower = body.toLowerCase();

      // 简写优先于裸词：`picked` 不该被当成文件名搜索。
      const short = SHORTHANDS[lower];
      if (short) {
        if (short === 'edited') {
          terms.push({ field: 'edited', op: '=', value: true, negated, raw });
        } else {
          terms.push({
            field: 'flag',
            op: '=',
            value: short.replace('flag-', ''),
            negated,
            raw,
          });
        }
        continue;
      }

      // 已知字段却不带值：`iso` 单独出现是漏了比较符，不是文件名。
      if (isQueryField(lower)) {
        const spec = FIELDS[lower];
        errors.push(
          spec.kind === 'bool'
            ? `「${lower}」不需要值，直接写 ${lower}。`
            : `「${lower}」需要一个值，例如 ${spec.example}。`,
        );
        continue;
      }

      // 其余一律当文件名子串 —— 兼容升级前的搜索框行为。
      terms.push({ field: 'name', op: 'contains', value: lower, negated, raw });
      continue;
    }

    const fieldName = m[1].toLowerCase();
    const opToken = m[2];
    const rawValue = m[3].trim();

    if (!isQueryField(fieldName)) {
      errors.push(`未知字段「${fieldName}」。可用字段：${AVAILABLE_FIELDS}。`);
      continue;
    }
    const field = fieldName;
    const spec = FIELDS[field];

    if (!rawValue) {
      pending.push(raw);
      continue;
    }

    if (spec.kind === 'bool') {
      errors.push(`「${field}」不需要值，直接写 ${field}。`);
      continue;
    }

    if (spec.kind === 'number') {
      const n = parseFieldNumber(field, rawValue);
      if (n === null) {
        errors.push(`「${field}」需要一个数字，例如 ${spec.example}。`);
        continue;
      }
      terms.push({
        field,
        op: opToken === ':' || opToken === '=' ? '=' : (opToken as QueryOp),
        value: n,
        negated,
        raw,
      });
      continue;
    }

    // 文本与枚举：值一律小写归一。
    const value = rawValue.toLowerCase();
    if (spec.kind === 'enum') {
      if (spec.values && !spec.values.includes(value)) {
        errors.push(`「${field}」只接受 ${spec.values.join(' / ')}。`);
        continue;
      }
      // 枚举是「等于」，不是「包含」：`flag:pick` 若用 contains 求值，
      // 未来出现 `picked` 这类取值时会误命中。
      terms.push({ field, op: '=', value, negated, raw });
      continue;
    }
    if (field === 'name') {
      // `name:` 一律走 glob（无通配符时等价于精确相等），与裸词的「子串」
      // 语义分开：写 `name:DSC0` 的用户是在指定完整文件名。
      terms.push({ field, op: 'glob', value, negated, raw });
      continue;
    }
    terms.push({ field, op: 'contains', value, negated, raw });
  }

  return { terms, errors, pending };
}

/** 组的全部文件路径（用于 folder / ext 判定）。 */
function filePaths(g: PhotoGroupInfo): string[] {
  return [g.raw?.path, g.jpg?.path, g.edited?.path].filter((p): p is string => !!p);
}

/** 父目录：兼容 `/` 与 `\` 两种分隔符。 */
function parentDir(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut > 0 ? path.slice(0, cut) : '';
}

function compareNumber(actual: number, op: QueryOp, want: number): boolean {
  switch (op) {
    case '=':
      return actual === want;
    case '>=':
      return actual >= want;
    case '<=':
      return actual <= want;
    case '>':
      return actual > want;
    case '<':
      return actual < want;
    default:
      return false;
  }
}

/** EXIF 字符串字段的数值比较；缺字段或解析失败都算不命中（不抛错）。 */
function compareExif(
  field: QueryField,
  raw: string | undefined,
  op: QueryOp,
  want: number,
): boolean {
  if (!raw) return false;
  const n = parseFieldNumber(field, raw);
  return n === null ? false : compareNumber(n, op, want);
}

function matchText(haystack: string, term: QueryTerm): boolean {
  const h = haystack.toLowerCase();
  const v = String(term.value);
  return term.op === 'glob' ? cachedGlob(v).test(h) : h.includes(v);
}

function evalTerm(g: PhotoGroupInfo, term: QueryTerm): boolean {
  switch (term.field) {
    case 'rating':
      return compareNumber(g.rating, term.op, term.value as number);

    case 'flag':
      return g.flag === term.value;

    case 'label': {
      const want = term.value as string;
      const have = (g.label || '').toLowerCase();
      // `label:none` 是「没有色标」的显式写法：空串本身没法写进查询串。
      return want === 'none' ? have === '' : have === want;
    }

    case 'name':
      return matchText(g.baseName, term);

    case 'ext': {
      const want = term.value as string;
      return [g.jpg, g.raw, g.edited].some((f) => f && f.extension.toLowerCase() === want);
    }

    case 'folder': {
      const want = term.value as string;
      return filePaths(g).some((p) => parentDir(p).toLowerCase().includes(want));
    }

    case 'edited':
      return !!g.edited;

    case 'iso':
      return compareExif('iso', g.exif?.iso, term.op, term.value as number);

    case 'aperture':
      return compareExif('aperture', g.exif?.aperture, term.op, term.value as number);

    case 'shutter':
      return compareExif('shutter', g.exif?.shutterSpeed, term.op, term.value as number);

    case 'focal':
      return compareExif('focal', g.exif?.focalLength, term.op, term.value as number);

    case 'camera': {
      const want = term.value as string;
      const make = (g.exif?.cameraMake || '').toLowerCase();
      const model = (g.exif?.cameraModel || '').toLowerCase();
      return make.includes(want) || model.includes(want);
    }

    case 'lens': {
      const want = term.value as string;
      return (g.exif?.lensModel || '').toLowerCase().includes(want);
    }

    default:
      return false;
  }
}

/**
 * 全部词条满足才通过（AND）。空词条恒真。
 *
 * 取反写在求值之后：`hit !== negated` 才继续。这样每个字段只需要实现
 * 「正面命中」一种语义，取反自动成立，不会出现「rating 的取反写错但
 * flag 的没写错」这类不一致。
 */
export function matchesQuery(g: PhotoGroupInfo, terms: readonly QueryTerm[]): boolean {
  for (const term of terms) {
    if (evalTerm(g, term) === term.negated) return false;
  }
  return true;
}

/**
 * 带错误处理的入口：解析出错时**放行全部**。
 *
 * 这是刻意的产品决策 —— 语法错误是提示，不是拒绝。否则用户少打一个字符，
 * 宫格就整屏清空，还得先想明白哪里错了才能恢复视图。
 */
export function matchesParsedQuery(g: PhotoGroupInfo, parsed: QueryParseResult): boolean {
  if (parsed.errors.length > 0) return true;
  return matchesQuery(g, parsed.terms);
}
