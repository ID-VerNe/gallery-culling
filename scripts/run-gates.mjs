#!/usr/bin/env node
/**
 * 按 `scripts/gates.json` 执行门禁（issue #6）。
 *
 * 本地与 CI 是**同一个入口**：`.github/workflows/ci.yml` 只调用本脚本，不再手写
 * 门禁数组；清单漂移由 `scripts/check-gates-manifest.mjs` 钉住。顺序、单门禁参数、
 * 每条 ci 门禁所属的 CI 分片（`shard`）都在清单里。
 *
 *     node scripts/run-gates.mjs ci                  # 全部 ci 门禁，按清单顺序
 *     node scripts/run-gates.mjs ci --shard static   # 只跑一个分片（CI matrix 用）
 *     node scripts/run-gates.mjs ci --fail-fast      # 本机快速试错：见到红就停
 *     node scripts/run-gates.mjs --list              # 档位计数、分片与 ci 顺序
 *
 * 片内默认**全跑并汇总**（一次红灯要看全貌），`--fail-fast` 才提前收手；无论哪种，
 * 片内始终串行 —— 并发跑会互相抢 CPU，App 级集成用例会在 5s 超时上假红
 * （AGENTS 环境坑里记着这件事，master 基线同条件也能复现）。
 *
 * 环境里有 `GITHUB_STEP_SUMMARY` 时把逐条结果写进 job 摘要，本机没有该变量时跳过。
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_PATH = join(ROOT, 'scripts', 'gates.json');
export const BUCKETS = ['ci', 'manual', 'support'];

const PASSED = '通过';
const FAILED = '失败';
const SKIPPED = '未执行';

/** 读清单。缺文件是硬错——没有清单就不该有任何「跑门禁」的动作。 */
export function loadManifest(path = MANIFEST_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function shardNames(manifest) {
  return (manifest.shards ?? []).map((row) => row.name);
}

export function shardRows(manifest, shard = null) {
  return (manifest.ci ?? []).filter((row) => shard === null || row.shard === shard);
}

export function counts(manifest) {
  return BUCKETS.map((name) => `${name} ${(manifest[name] ?? []).length}`).join('、');
}

export function shardCounts(manifest) {
  const tally = Object.fromEntries(shardNames(manifest).map((name) => [name, 0]));
  for (const row of manifest.ci ?? []) {
    tally[row.shard] = (tally[row.shard] ?? 0) + 1;
  }
  return Object.entries(tally)
    .map(([name, count]) => `${name} ${count}`)
    .join('、');
}

/** `--list`：档位计数、分片与 ci 顺序。 */
export function listGates(manifest) {
  console.log(`清单：scripts/gates.json（${counts(manifest)}）`);
  console.log(`CI 分片：${shardCounts(manifest)}`);
  let current = null;
  (manifest.ci ?? []).forEach((row, index) => {
    if (row.shard !== current) {
      current = row.shard;
      console.log(`[${current}]`);
    }
    console.log(`${String(index + 1).padStart(3)}. ${row.name} — ${row.why}`);
  });
  return 0;
}

/** 门禁命令行：argv 数组，不经 shell 拼串（Windows 上引号与空格是雷）。 */
export function commandOf(row) {
  if (!Array.isArray(row.cmd) || row.cmd.length === 0) {
    throw new Error(`门禁 ${row.name} 缺少 cmd 数组`);
  }
  return row.cmd;
}

function runOne(row) {
  const cwd = row.cwd ? join(ROOT, row.cwd) : ROOT;
  const [command, ...args] = commandOf(row);
  // Windows 上 npx/npm/cargo 都是 .cmd 垫片，不起 shell 就 spawn 不了；
  // 本仓的门禁参数里没有空格，shell 拼接不会出岔子。
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });
  if (result.error) {
    console.error(`  spawn 失败：${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

/** 片内逐条串行跑；返回 { results: [{row, status, seconds}], elapsed }。 */
export function runRows(rows, failFast = false) {
  const results = [];
  const total = rows.length;
  const started = Date.now();

  rows.forEach((row, index) => {
    const tick = Date.now();
    const code = runOne(row);
    const seconds = (Date.now() - tick) / 1000;
    const status = code === 0 ? PASSED : FAILED;
    results.push({ row, status, seconds });
    console.log(`[${index + 1}/${total}] ${row.name} ${status} (${seconds.toFixed(1)}s)`);
    if (status === FAILED && failFast && index + 1 < total) {
      for (const rest of rows.slice(index + 1)) {
        results.push({ row: rest, status: SKIPPED, seconds: 0 });
      }
      console.log(`  后续 ${total - index - 1} 条未执行（--fail-fast）`);
    }
  });

  return { results, elapsed: (Date.now() - started) / 1000 };
}

/** 分片结果表：逐条结果 + 通过/失败/未执行计数 + 耗时。 */
export function summaryText(results, shard, elapsed) {
  const passed = results.filter((item) => item.status === PASSED).length;
  const skipped = results.filter((item) => item.status === SKIPPED).length;
  const failed = results.filter((item) => item.status === FAILED).map((item) => item.row.name);
  const lines = [
    `### 门禁分片 \`${shard}\`（${results.length} 条）`,
    '',
    `${PASSED} ${passed} · ${FAILED} ${failed.length} · ${SKIPPED} ${skipped} · 耗时 ${elapsed.toFixed(1)}s`,
    '',
  ];
  if (failed.length > 0) {
    lines.push(`失败：${failed.map((name) => `\`${name}\``).join('、')}`, '');
  }
  lines.push('| # | 门禁 | 结果 | 耗时 |', '|---|---|---|---|');
  results.forEach((item, index) => {
    lines.push(`| ${index + 1} | \`${item.row.name}\` | ${item.status} | ${item.seconds.toFixed(1)}s |`);
  });
  return `${lines.join('\n')}\n`;
}

function writeSummary(results, shard, elapsed) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  appendFileSync(path, summaryText(results, shard, elapsed), 'utf8');
}

export function runCi(manifest, shard = null, failFast = false) {
  const rows = shardRows(manifest, shard);
  if (rows.length === 0) {
    console.error(`FAIL: 分片 ${shard ?? '(全部)'} 里没有门禁`);
    return 1;
  }
  console.log(`门禁 ${rows.length} 条，分片 ${shard ?? '全部分片'}，顺序来自 scripts/gates.json`);
  const { results, elapsed } = runRows(rows, failFast);
  writeSummary(results, shard ?? 'all', elapsed);

  const failed = results.filter((item) => item.status === FAILED).map((item) => item.row.name);
  if (failed.length > 0) {
    console.log(`FAIL: ${failed.length} 条未通过：${failed.join('、')}`);
    return 1;
  }
  console.log(`PASS: ${results.length} 条门禁全部通过（${elapsed.toFixed(1)}s）`);
  return 0;
}

function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--list')) {
    return listGates(loadManifest());
  }

  const group = args.find((arg) => !arg.startsWith('--'));
  if (group !== 'ci') {
    console.error('用法：node scripts/run-gates.mjs ci [--shard <name>] [--fail-fast] [--list]');
    return 2;
  }

  const shardIndex = args.indexOf('--shard');
  const shard = shardIndex === -1 ? null : args[shardIndex + 1];
  const failFast = args.includes('--fail-fast');

  const manifest = loadManifest();
  if (shard !== null && !shardNames(manifest).includes(shard)) {
    console.error(`FAIL: 未知分片 ${JSON.stringify(shard)}；合法值：${shardNames(manifest).join('、')}`);
    return 2;
  }
  return runCi(manifest, shard, failFast);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv));
}
