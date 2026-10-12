import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import {
  AppSettings,
  ExportItem,
  FolderScanResult,
  LumenCapabilities,
  LumenMask,
  LumenMaskResult,
  LumenPreviewResult,
  LumenRatingSyncResult,
  LumenRecipe,
  LumenStatus,
  MaskAdjustments,
  ToneAdjustments,
  ToneState,
  ToneWriteReport,
} from '../types';

export const api = {
  /**
   * Scan JPG and RAW folders
   */
  scanFolders: async (
    jpgFolder: string,
    rawFolder?: string,
    sortOrder?: string,
  ): Promise<FolderScanResult> => {
    return await invoke<FolderScanResult>('scan_folders_cmd', {
      jpgFolder,
      rawFolder: rawFolder || null,
      sortOrder: sortOrder || null,
    });
  },

  /**
   * Get or generate thumbnail path for an image
   */
  getThumbnail: async (filePath: string, width?: number): Promise<string> => {
    const localCachePath = await invoke<string>('get_thumbnail_cmd', {
      filePath,
      width: width || 200,
    });
    return convertFileSrc(localCachePath);
  },

  /**
   * Update photo rating and pick/reject flag
   */
  updateRatingFlag: async (
    filePath: string,
    rating: number,
    flag: string,
    syncXmp: boolean = true,
  ): Promise<boolean> => {
    return await invoke<boolean>('update_rating_flag_cmd', {
      filePath,
      rating,
      flag,
      syncXmp,
    });
  },

  /**
   * Open file in Photoshop
   */
  openInPhotoshop: async (
    filePath: string,
    customPsPath?: string,
  ): Promise<boolean> => {
    return await invoke<boolean>('open_in_photoshop_cmd', {
      filePath,
      customPsPath: customPsPath || null,
    });
  },

  /**
   * Open file in OS default application
   */
  openInDefaultApp: async (filePath: string): Promise<boolean> => {
    return await invoke<boolean>('open_in_default_app_cmd', {
      filePath,
    });
  },

  /**
   * Save tone adjustments to XMP sidecar for Adobe Camera Raw compatibility
   */
  updateToneAdjustments: async (
    filePath: string,
    tone: ToneAdjustments,
  ): Promise<boolean> => {
    return await invoke<boolean>('update_tone_adjustments_cmd', {
      filePath,
      tone,
    });
  },

  /**
   * Open image in Luminar AI using Photoshop Plugin mode and return edited image path
   */
  openInLuminarRoundtrip: async (filePath: string): Promise<string> => {
    return await invoke<string>('open_in_luminar_roundtrip_cmd', {
      filePath,
    });
  },

  /**
   * Move photos to OS Recycle Bin
   */
  trashPhotos: async (filePaths: string[]): Promise<number> => {
    return await invoke<number>('trash_photos_cmd', {
      filePaths,
    });
  },

  /**
   * Batch copy/export selected photos
   */
  batchExport: async (
    items: ExportItem[],
    targetFolder: string,
    includeRaw: boolean,
    includeJpg: boolean,
  ): Promise<number> => {
    return await invoke<number>('batch_export_cmd', {
      items,
      targetFolder,
      includeRaw,
      includeJpg,
    });
  },

  /**
   * Batch update lens metadata (lens model, focal length, aperture) into XMP sidecars
   */
  batchUpdateMetadata: async (
    filePaths: string[],
    lensModel?: string,
    focalLength?: string,
    aperture?: string,
  ): Promise<number> => {
    return await invoke<number>('batch_update_metadata_cmd', {
      filePaths,
      lensModel: lensModel || null,
      focalLength: focalLength || null,
      aperture: aperture || null,
    });
  },

  /**
   * Load app settings from SQLite
   */
  getSettings: async (): Promise<AppSettings> => {
    return await invoke<AppSettings>('get_settings_cmd');
  },

  /**
   * Save app settings to SQLite
   */
  saveSettings: async (settings: AppSettings): Promise<boolean> => {
    return await invoke<boolean>('save_settings_cmd', { settings });
  },

  /**
   * Save session browsing history
   */
  saveSession: async (
    jpgFolder: string,
    rawFolder: string,
    lastIndex: number,
    sortOrder: string,
  ): Promise<boolean> => {
    return await invoke<boolean>('save_session_cmd', {
      jpgFolder,
      rawFolder,
      lastIndex,
      sortOrder,
    });
  },

  /**
   * Load session browsing history
   */
  loadSession: async (
    jpgFolder: string,
  ): Promise<[number, string] | null> => {
    return await invoke<[number, string] | null>('load_session_cmd', {
      jpgFolder,
    });
  },

  /**
   * Open native folder picker dialog
   */
  selectFolderDialog: async (defaultPath?: string): Promise<string | null> => {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: defaultPath || undefined,
      title: '选择照片文件夹',
    });
    return typeof selected === 'string' ? selected : null;
  },

  /**
   * Convert local disk path to Tauri asset:// URL for zero-copy streaming
   */
  toAssetUrl: (filePath: string): string => {
    return convertFileSrc(filePath);
  },

  /**
   * LUMEN RAW 集成握手状态（available=false 时前端静默降级）
   */
  getLumenStatus: async (): Promise<LumenStatus> => {
    return await invoke<LumenStatus>('lumen_status_cmd');
  },

  /**
   * 经 LUMEN RAW sidecar 渲染 RAW 预览。
   * previewPath 为 null 表示引擎不可用（调用方应回退内嵌 JPEG 路径）。
   */
  getLumenPreview: async (
    filePath: string,
    opts?: { width?: number; original?: boolean; recipe?: unknown },
  ): Promise<LumenPreviewResult> => {
    return await invoke<LumenPreviewResult>('lumen_preview_cmd', {
      filePath,
      width: opts?.width ?? null,
      original: opts?.original ?? null,
      recipe: opts?.recipe ? JSON.stringify(opts.recipe) : null,
    });
  },

  /**
   * 从 LUMEN RAW 拉取该文件夹的评级并写回侧边栏（返回被更新的文件路径）。
   * 引擎关闭或未安装时返回空数组（静默降级）。
   */
  syncLumenRatings: async (folder: string): Promise<LumenRatingSyncResult> => {
    return await invoke<LumenRatingSyncResult>('lumen_sync_ratings_cmd', { folder });
  },

  /** 读取 LUMEN RAW 侧 recipe（available=false 表示引擎不可用） */
  getLumenRecipe: async (filePath: string): Promise<LumenRecipe> => {
    return await invoke<LumenRecipe>('lumen_get_recipe_cmd', { filePath });
  },

  /** 把调色滑杆写入 LUMEN RAW recipe */
  applyLumenRecipe: async (filePath: string, changes: unknown): Promise<void> => {
    await invoke('lumen_apply_recipe_cmd', {
      filePath,
      recipeJson: JSON.stringify(changes),
    });
  },

  /** 探测 sidecar 能力（命令表 + 预设 + AI 可用性） */
  getLumenCapabilities: async (): Promise<LumenCapabilities> => {
    return await invoke<LumenCapabilities>('lumen_capabilities_cmd');
  },

  /** 应用 LUMEN RAW 内置预设（amount 0..100） */
  applyLumenPreset: async (filePath: string, name: string, amount = 100): Promise<void> => {
    await invoke('lumen_apply_preset_cmd', { filePath, name, amount });
  },

  /**
   * 统一调色写入：XMP + （引擎可用时）LUMEN RAW 编辑态并落盘 .lumen 工程。
   * 引擎失败不会回滚 XMP，只在 report.warnings 里说明。
   */
  applyTone: async (filePath: string, tone: ToneAdjustments): Promise<ToneWriteReport> => {
    return await invoke<ToneWriteReport>('apply_tone_cmd', { filePath, tone });
  },

  /** 统一调色读取：返回生效值 + 两个真值 + 是否分歧 */
  getToneState: async (filePath: string): Promise<ToneState> => {
    return await invoke<ToneState>('get_tone_state_cmd', { filePath });
  },

  /**
   * 应用 AI 蒙版（需 GPU 版 LUMEN RAW）。CPU 版会明确报错而不是静默成功。
   * 实耗时约 4s —— 调用方必须给进度反馈。
   */
  applyLumenMask: async (
    filePath: string,
    region: string,
    adjustments: MaskAdjustments,
  ): Promise<LumenMaskResult> => {
    return await invoke<LumenMaskResult>('lumen_apply_mask_cmd', {
      filePath,
      region,
      adjustments,
    });
  },

  /** 读回工程里现有的 AI 蒙版 */
  listLumenMasks: async (filePath: string): Promise<LumenMask[]> => {
    return await invoke<LumenMask[]>('lumen_list_masks_cmd', { filePath });
  },
};
