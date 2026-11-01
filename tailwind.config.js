/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: {
          /**
           * 唯一需要 `/NN` 修饰的颜色（issue #15）。
           *
           * Tailwind 3 的 `/NN` 必须能从颜色值里**解析出通道**才能拼 `rgb(... / a)`；
           * 直接写 `var(--color-bg-base)` 时它解析不了，`bg-background-base/90`
           * 这类规则会被**静默丢弃**（不报错、不警告，页面退回透明）。
           *
           * 所以这里用「通道三元组令牌 + <alpha-value>」：`--color-bg-base-rgb` 存
           * `10 10 10`（即 #0A0A0A），`/NN` 由 Tailwind 填进 `<alpha-value>`。
           * 原令牌 `--color-bg-base` 保留，供内联 style / 直接 var() 引用。
           *
           * 其余 background/border/button 色零处使用 `/NN`，保持 `var()` 不动
           * （地盘见 `scripts/check-theme-alpha.mjs` 的动态扫描）。
           */
          base: 'rgb(var(--color-bg-base-rgb) / <alpha-value>)',
          surface: 'var(--color-bg-surface)',
          'surface-hover': 'var(--color-bg-surface-hover)',
          header: 'var(--color-bg-header)',
          panel: 'var(--color-bg-panel)',
          input: 'var(--color-bg-input)',
        },
        border: {
          subtle: 'var(--color-border-subtle)',
          default: 'var(--color-border-default)',
          strong: 'var(--color-border-strong)',
        },
        button: {
          DEFAULT: 'var(--color-bg-button)',
          hover: 'var(--color-bg-button-hover)',
        }
      }
    },
  },
  plugins: [],
}
