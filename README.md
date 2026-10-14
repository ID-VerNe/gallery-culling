[中文版本](README_zh-CN.md)

# Gallery Culling — Native High-Speed Photo Selector (Tauri 2.0)

A high-performance desktop photo culling application built with **Tauri 2.0 + Rust + React 19 + TypeScript**. Tailored for photographers and digital asset managers to load thousands of high-resolution photos in milliseconds, pair JPGs with camera RAW files, rate 1-5 stars, flag pick/reject, compare shots side-by-side with synchronized pan & zoom, and seamlessly read/write standard Adobe Lightroom / Capture One XMP sidecar files.

---

## Key Features

*   **Native Rust Architecture (Tauri 2.0):** Lightweight footprint, zero Python runtime overhead, instant startup, and direct OS dialog integration.
*   **3~4 Column Compact Sidebar Grid:** High-density virtualized thumbnail grid powered by `@tanstack/react-virtual`. Smooth 60 FPS scrolling across 10,000+ images without DOM bloat.
*   **Upright Orientation Engine:** Automatically extracts EXIF Orientation metadata and applies lossless rotation so vertical portraits are always displayed upright.
*   **Hybrid Accelerated Thumbnail Generation:** Rust native thread pool extracts embedded EXIF/RAW previews within milliseconds; falls back to SIMD-accelerated downsampling (`fast_image_resize`) with persistent disk cache.
*   **Smart RAW + JPG Pairing:** Case-insensitive pairing for matching base names across JPG/PNG and RAW formats (Sony ARW, Canon CR2/CR3, Nikon NEF, Fujifilm RAF, DNG, etc.).
*   **Split Compare View (A/B Testing):**
    *   Side-by-side comparison for focus sharpness and micro-expressions;
    *   **Mouse Left-Click Pan Dragging:** Freely pan around the frame; with "Sync" enabled, both viewports move with exact pixel-matched delta increments;
    *   Double-click to toggle between 1.0x and 2.5x zoom with automatic origin reset;
    *   Pin any reference shot as a benchmark, cycling through candidates on the right.
*   **Manual Lens & Metadata Editor (XMP Batch Sync):**
    *   Quickly input Lens Model, Focal Length, and Aperture for vintage manual or adapter lenses;
    *   Batch-synchronize metadata directly into `.xmp` sidecar files across selected or matched photos for instant recognition in Lightroom / Capture One.
*   **Two-Way XMP Synchronization:**
    *   1-5 star ratings and Pick/Reject flags are automatically saved to standard `.xmp` sidecars in real-time.
*   **Single-Handed Keyboard Shortcuts:**
    *   `1` ~ `5`: Set 1-5 star rating
    *   `0` / `U`: Clear rating and flag (Unmark)
    *   `P`: Flag as Pick (Green)
    *   `X`: Flag as Reject (Red)
    *   `A` / `D` or `←` / `→`: Navigate Previous / Next
    *   `O`: Open current RAW file in Photoshop or default viewer
    *   `C`: Toggle Single View / Split Compare View
    *   `[`: Pin Left image as benchmark
    *   `]` or `Space`: Pin Right candidate as new benchmark
    *   `B`: Toggle / release benchmark lock
    *   `S`: Swap Left and Right images
    *   `M`: Open Manual Lens Metadata Editor
*   **Batch Export:** Copy Picked or filtered RAW, JPG, and XMP sidecar files into an export destination with one click.
*   **Session Persistence:** Embedded SQLite database saves folder paths and current browsing position for instant resume.

---

## Tech Stack

*   **Desktop Shell:** Tauri 2.0 (`tauri`, `protocol-asset`)
*   **Backend Core:** Rust (`image`, `fast_image_resize`, `kamadak-exif`, `rusqlite`, `trash`, `rayon`, `tokio`)
*   **Frontend:** React 19, TypeScript, Vite 6, Tailwind CSS
*   **Package Manager:** `npm`
*   **Legacy Archive:** The original Python Flask version is safely archived in `legacy_flask/`.

---

## Development & Build

### Prerequisites
*   **Node.js** >= 18 (v20+ recommended)
*   **npm** >= 10 (bundled with Node.js v20+)
*   **Rust** >= 1.77 (`rustc` & `cargo`)

### Quick Start

1.  Clone the repository:
    ```bash
    git clone https://github.com/ID-VerNe/gallery-culling.git
    cd gallery-culling
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Launch development environment:
    ```bash
    npm run tauri dev
    ```

### Release Build
```bash
npm run tauri build
```
The compiled standalone executable and installer will be generated in `src-tauri/target/release/`.

For a signed release that also produces the auto-update metadata (`updater.json`), run:
```bash
node scripts/release.mjs
```

---

## License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
