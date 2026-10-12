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
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    // describe/it/expect 走全局，测试文件顶部不必重复 import；
    // tsconfig.json 已注入 `vitest/globals` + `@testing-library/jest-dom` 类型。
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // 套件只覆盖 `src`，src-tauri / scripts 不进 jsdom 环境。
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
