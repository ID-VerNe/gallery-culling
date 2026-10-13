import { useCallback, useEffect, useState } from 'react';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';

interface PendingUpdate {
  version: string;
  body: string;
  install: () => Promise<void>;
}

/**
 * 应用更新：启动 1.5s 后静默探测一次，有新版才弹窗。
 *
 * 三条约定：
 * - **探测失败静默**。查不到更新对用户不可操作，刷一个 toast 只会制造噪音
 *   （一个连 `check()` 失败的 app 不需要告诉用户「更新检查失败了」）。
 * - **安装期间弹窗不关**（A1）。否则进度无从查看，用户会以为程序卡死。
 * - **探测延后 1.5s**，不与首屏渲染抢资源。
 */
export function useAutoUpdate() {
  const toast = useToast();
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateStatus, setUpdateStatus] = useState('');
  const [pendingUpdate, setPendingUpdate] = useState<PendingUpdate | null>(null);

  useEffect(() => {
    const checkForUpdates = async () => {
      try {
        const update = await check();
        if (!update) return;
        setPendingUpdate({
          version: update.version,
          body: update.body || '修复已知问题，优化体验。',
          install: async () => {
            // A1：安装期间保持弹窗可见并显示进度，避免「点了没反应以为死机」。
            setUpdateBusy(true);
            setUpdateStatus('正在准备下载…');
            let downloaded = 0;
            let total: number | null = null;
            try {
              await update.downloadAndInstall((event) => {
                if (event.event === 'Started') {
                  total = event.data.contentLength ?? null;
                  setUpdateStatus('正在下载…');
                } else if (event.event === 'Progress') {
                  downloaded += event.data.chunkLength;
                  setUpdateStatus(
                    total
                      ? `正在下载 ${Math.min(
                          100,
                          Math.round((downloaded / total) * 100),
                        )}%`
                      : '正在下载…',
                  );
                } else if (event.event === 'Finished') {
                  setUpdateStatus('正在安装，即将重启…');
                }
              });
              await relaunch();
            } catch (err) {
              console.error('Failed to install update:', err);
              setUpdateBusy(false);
              setUpdateStatus('');
              setPendingUpdate(null);
              toast.error(
                `升级失败：${String(err)}\n请检查网络后重试，或到发布页手动下载安装包。`,
              );
            }
          },
        });
      } catch (err) {
        // Silent by design: a failed update check is not actionable for the user.
        console.error('Failed to check for updates:', err);
      }
    };
    // small delay to not block initial render
    const timer = window.setTimeout(checkForUpdates, 1500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const dismiss = useCallback(() => {
    // A1：下载/安装进行中不许关窗（否则进度无从查看，用户以为卡死）。
    if (!updateBusy) setPendingUpdate(null);
  }, [updateBusy]);

  const install = useCallback(() => {
    void pendingUpdate?.install();
  }, [pendingUpdate]);

  /** 更新提示弹窗。调用方直接放进 JSX 即可。 */
  const dialog = (
    <ConfirmDialog
      isOpen={pendingUpdate !== null}
      onClose={dismiss}
      onConfirm={install}
      title={`发现新版本 ${pendingUpdate?.version ?? ''}`}
      message={
        <>
          {`更新内容：\n${pendingUpdate?.body ?? ''}`}
          {'\n\n是否立即下载并升级？升级完成后应用会自动重启。'}
        </>
      }
      confirmLabel="下载并升级"
      cancelLabel="稍后再说"
      busy={updateBusy}
      busyLabel={updateStatus || '正在更新…'}
      closeOnConfirm={false}
    />
  );

  return { dialog, updateBusy, updateStatus };
}