/**
 * 版本号三处一致（issue #23）。
 *
 * `package.json`、`src-tauri/tauri.conf.json`、`package-lock.json` 的根包版本是同一件事的
 * 三个副本。2.0.4 那次 bump（`349282e`）只改了前两个，lock 停在 2.0.0，而 `npm ci` 不报错、
 * 也没有任何门禁拦——不一致就这样躺了一个版本。
 *
 * 为什么不是「让 lock 自己去对齐」：`npm install` 顺手改的是 lock，改不了的正是**漏改**
 * 这个动作本身。下一次 release 再漏一次，仍然没人能靠对账发现。所以这里把对账变成门禁。
 *
 * `src-tauri/tauri.conf.json` 的版本是安装包版本，与前端版本必须同步发布；
 * 它读不出来（文件不在、`version` 不是字符串）也算红——门禁的价值就在于「文件消失」也被看见。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 从三份 JSON 文本里取出版本号，返回 `{ versions, problems }`。纯函数，供单测。
 *
 * `problems` 收的是「取不到版本」这类结构性错误；`problems` 为空时 `versions` 才有意义。
 * 刻意把「读文件」与「判一致」拆开：一致性判定要能拿假数据打红，不该依赖磁盘。
 */
export function collectVersions({ pkg, lock, tauri }) {
  const problems = [];
  const versions = [];

  const pick = (label, text, read) => {
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      problems.push(`${label} 不是合法 JSON（${error.message}）`);
      return;
    }
    const version = read(data);
    if (typeof version !== 'string' || version.length === 0) {
      problems.push(`${label} 里取不到字符串型版本号`);
      return;
    }
    versions.push({ label, version });
  };

  pick('package.json', pkg, (data) => data.version);
  pick('src-tauri/tauri.conf.json', tauri, (data) => data.version);
  // lock 里有两处：顶层的 `version` 与 `packages[""]`（根包）。npm 会同时写，
  // 只查一处的话「只改了一处」这种半吊子状态照样绿。两边都进比对。
  pick('package-lock.json 的 version', lock, (data) => data.version);
  pick('package-lock.json 的 packages[""].version', lock, (data) => data.packages?.['']?.version);

  return { versions, problems };
}

/** 一致性判定：返回 `{ ok, message }`。纯函数，便于单测与变异。 */
export function judgeVersions({ versions, problems }) {
  if (problems.length > 0) {
    return { ok: false, message: `FAIL: 版本号取不全\n${problems.map((p) => `  - ${p}`).join('\n')}` };
  }
  const distinct = [...new Set(versions.map((item) => item.version))];
  if (distinct.length === 1) {
    return {
      ok: true,
      message: `PASS: 版本号三处一致（${versions.map((item) => item.label).join('、')} 都是 ${distinct[0]}）。`,
    };
  }
  const detail = versions.map((item) => `  - ${item.label}：${item.version}`).join('\n');
  return {
    ok: false,
    message:
      `FAIL: 版本号不一致\n${detail}\n` +
      '  处置：把落后的那份对齐到最新版本，别只改一半。bump 脚本要同时改 package.json、' +
      'src-tauri/tauri.conf.json 与 package-lock.json 的两处根版本。',
  };
}

/** 读三份文件并判定，返回 `{ ok, message }`；IO 留在这里，判定逻辑在上面的纯函数里。 */
export function checkVersions({ root = ROOT, read = (path) => readFileSync(path, 'utf8') } = {}) {
  const files = {
    pkg: join(root, 'package.json'),
    lock: join(root, 'package-lock.json'),
    tauri: join(root, 'src-tauri', 'tauri.conf.json'),
  };
  const missing = [];
  const texts = {};
  for (const [key, path] of Object.entries(files)) {
    try {
      texts[key] = read(path);
    } catch {
      missing.push(key);
    }
  }
  if (missing.length > 0) {
    return { ok: false, message: `FAIL: 读不到 ${missing.map((key) => files[key]).join('、')}` };
  }
  return judgeVersions(collectVersions(texts));
}

function main() {
  const { ok, message } = checkVersions();
  if (!ok) {
    console.error(message);
    return 1;
  }
  console.log(message);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
