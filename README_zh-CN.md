[English Version](README.md)

# 快速选图工具 (Gallery Culling) — Tauri 2.0 原生极速版

一个基于 **Tauri 2.0 + Rust + React 19 + TypeScript** 构建的高性能专业选片桌面应用。专为摄影师和图像处理专业人员打造，可秒级加载数千至上万张照片，极速配对浏览 JPG 与相机 RAW 图像，支持 1-5 星级打分、Pick/Reject 标记、双图并排联动对比与 Adobe Lightroom / Photoshop XMP 侧边栏双向无缝互通。

---

## 核心特性

*   **极致性能原生架构：** 采用 Tauri 2.0 原生架构，摆脱 Python 运行环境依赖与外部对话框子进程，内存占用极小、毫秒级秒开。
*   **右侧 3~4 列紧凑宫格：** 右侧缩略图支持 3 列 / 4 列高密度宫格一键切换，基于 `@tanstack/react-virtual` 虚拟化渲染，万张照片 60fps 丝滑滚动，告别低效单列瀑布流。
*   **智能直立方向渲染：** 自动识别 EXIF Orientation 信息并无损校正，竖屏照片始终保持直立显示。
*   **混合极速缩略图引擎：** Rust 原生线程池优先提取 EXIF / RAW 内嵌预览图（数毫秒级），缺失时自动通过 `fast_image_resize` (SIMD 指令集加速) 进行高质量下采样并持久化磁盘缓存。
*   **RAW 与 JPG 智能配对：** 忽略大小写自动将同名 JPG/PNG 与各种相机 RAW（Sony ARW、Canon CR2/CR3、Nikon NEF、Fujifilm RAF、DNG 等）配对关联。
*   **双图并排联动对比 (Split Compare View)：**
    *   同屏双图对比对焦清晰度与面部表情；
    *   **支持鼠标左键自由拖拽平移 (Pan)**，联动开启时双图保持绝对像素级同步增量平移；
    *   双击快速在 1.0x 与 2.5x 细节放大之间平滑切换并复位；
    *   支持固定对比基准图（Benchmark），右侧连续切换候选图对比。
*   **手动镜头元数据录入与批量同步 (Manual Lens XMP Sync)：**
    *   针对手动转接镜头或无触点镜头，快速录入镜头型号、焦段与光圈；
    *   一键将镜头参数批量写入选定照片或同镜头组的所有 XMP 侧边栏文件，导入 Lightroom / Capture One 即可识别完整 EXIF。
*   **Lightroom / Capture One XMP 双向互通：**
    *   软件内 1-5 星级打分与 Pick/Reject 标记，自动无损同步写入/读取标准 `.xmp` 侧边栏文件，修图软件打开直接生效。
*   **单手键盘极速选片快捷键：**
    *   `1` ~ `5`：设置 1-5 星级
    *   `0` / `U`：清除评级与标记
    *   `P`：标记保留 (Pick，绿标)
    *   `X`：标记淘汰 (Reject，红标)
    *   `A` / `D` 或 `←` / `→`：上一张 / 下一张
    *   `O`：使用 Photoshop 或系统默认程序打开当前 RAW 原片
    *   `C`：切换单图检视 / 双图对比模式
    *   `[`：锁定左图为对比基准 (Pin Left)
    *   `]` 或 `空格`：将右侧候选图设为新基准 (Pin Right / Candidate)
    *   `B`：切换/解除对比基准锁定 (Toggle Benchmark)
    *   `S`：左右对比照片互换 (Swap A/B)
    *   `M`：呼出手工镜头元数据录入与批量同步窗口
*   **批量挑选导出：** 一键将保留 (Pick) 或指定星级以上的 RAW 原片、JPG 预览及 XMP 侧边栏文件快速复制到目标目录。
*   **本地会话记忆：** 内嵌 SQLite 自动记忆上一次打开的目录与选片浏览断点，下次打开秒级还原。

---

## 架构技术栈

*   **桌面框架：** Tauri 2.0 (`tauri`, `protocol-asset`)
*   **后端核心：** Rust (`image`, `fast_image_resize`, `kamadak-exif`, `rusqlite`, `trash`, `rayon`, `tokio`)
*   **前端框架：** React 19, TypeScript, Vite 6, Tailwind CSS
*   **包管理器：** `npm`
*   **旧版归档：** 原 Python Flask 实现已完整归档在 `legacy_flask/` 目录下。

---

## 开发与运行

### 先决条件
*   **Node.js** >= 18 (推荐 v20+)
*   **npm** >= 10 (随 Node.js v20+ 附带)
*   **Rust** >= 1.77 (`rustc` 与 `cargo`)

### 快速启动

1.  克隆仓库：
    ```bash
    git clone https://github.com/ID-VerNe/gallery-culling.git
    cd gallery-culling
    ```
2.  安装前端依赖：
    ```bash
    npm install
    ```
3.  启动开发环境：
    ```bash
    npm run tauri dev
    ```

### 编译打包单可执行文件 (Release Build)
```bash
npm run tauri build
```
编译生成的便携版 `.exe` 与安装程序将输出在 `src-tauri/target/release/`。

如需产出带签名、并生成自动更新元数据（`updater.json`）的正式发版包，运行：
```bash
node scripts/release.mjs
```

---

## 许可证
本项目采用 MIT 许可证 - 详情请参阅 [LICENSE](LICENSE) 文件。
