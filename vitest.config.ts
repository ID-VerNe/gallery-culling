/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * 前端测试基座（LUMEN RAW 集成回归）。
 *
 * 与 `vite.config.ts` 的关系：应用构建仍然只读 `vite.config.ts`；本文件只在
 * vitest 下生效，并复用同一个 react 插件，保证 JSX 转换行为一致。
 * 注意：**不要**在这里写 `test:` 之外的构建/插件配置，否则会和 vite.config.ts
 * 分叉。
 *
 * ── pool 说明（2026-10-12 调查结论，M-16）─────────────────────────
 * **刻意不固定 pool**（保持默认 `forks`）。
 *
 * 初始审计曾记录「默认 pool 下 `pnpm test` 9/9 测试文件全部启动失败、0 用例
 * 执行」，并建议固定 `pool: 'vmForks'`。复核**未复现**该现象：默认 `forks`
 * 下连续 6 次 + 3 并发全部全绿；`forks` / `threads` / `vmForks` **三者都能
 * 全绿**，`vmForks` 并非解药（且更慢、更吃内存）。
 *
 * 判定：这是 vitest 4.1.x 在 Windows 上「`npm install` 后首次运行窗口内的
 * pool 启动竞态」的**瞬时**故障（上游 vitest-dev/vitest#10812 / #8861），
 * 与 setupFiles / 显式 import / 本仓库配置均无关（9 个测试文件全部显式
 * `import from 'vitest'` 且全绿）。
 *
 * 因此**不要**把 pool 固定成 `vmForks` —— 那是在无失败样本时改变模块求值
 * 语义，风险 > 收益，且上游 #8861 显示 vmForks 同样会命中该竞态。
 * 若 CI 上再次复现，逃生阀是**命令行**参数：
 *     npx vitest run --pool=vmForks      （或 --maxWorkers=1）
 * 并在 CI 注释里写明「规避上游竞态，非终态」，便于随时回滚。
 * ─────────────────────────────────────────────────────────────────
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    /**
     * 默认 5s 对「挂载整个 App」的集成用例太紧：`App.scanProgress` /
     * `App.taskMutex` / `App.toneSave` 单跑一条要 1.2–1.5s，而全量 84 个文件并行、
     * 机器上同时还在编译 Rust 时，同一条会顶到 5s 以上——**报的是超时，不是断言失败**，
     * 于是红灯说的不是代码坏了（2026-11-01 实测：master 基线同条件复跑也红，单独复跑全绿）。
     *
     * 放宽到 15s 只影响「卡住多久算挂」，不放松任何断言；真正的死循环照样红。
     * 这条是让 `npm run gates` 的 unit 分片可用的前提，别改回默认值。
     */
    testTimeout: 15000,
    // describe/it/expect 走全局，测试文件顶部不必重复 import；
    // tsconfig.json 已注入 `vitest/globals` + `@testing-library/jest-dom` 类型。
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'src/**/*.{test,spec}.mjs', 'scripts/**/*.test.mjs'],
    // 应用用例只覆盖 `src`；`scripts/**/*.test.mjs` 是门禁自身的单测（issue #6）——
    // 元门禁坏了是静默放行，它必须被自己的用例盯住。src-tauri 不进 jsdom 环境。
    exclude: ['node_modules/**', 'dist/**', 'src-tauri/**', '.venv/**'],
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/main.tsx', 'src/vite-env.d.ts'],
    },
  },
});
