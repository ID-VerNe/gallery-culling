/**
 * 应用更新（issue #43 / #49）。
 *
 * 链路事实（Windows / WebView2）：
 * - `downloadAndInstall` 启动 NSIS 安装器后**直接 `std::process::exit(0)`**
 *   （`tauri-plugin-updater-2.11.0/src/updater.rs:862-876`），Promise 永不 resolve；
 * - 因此原来的 `await relaunch()` 与随后的 catch 在 Windows 上都是死代码；
 * - **#49 起不再依赖模板的 `/R`**：模板 `.onInstSuccess` 调的
 *   `nsis_tauri_utils::RunAsUser` 不检查返回值，提权安装器里它返回 1 却静默，
 *   用户装完没人把应用拉回来（#43 真机回签失败的根因）。
 *   现在由 `src-tauri/nsis/update-hooks.nsh` 显式接管重启（含 explorer 兜底与
 *   可见的「重试启动」对话框），前端传 `restartAfterInstall: false` 关掉模板的
 *   `/R`（`updater.rs:890-903` 只在为 true 时才追加 `/R`），避免两边各拉一次。
 *
 * 兜底（PB）：安装前写 `gc:update:pending`（`src/utils/updatePending.ts`）；
 * 下次启动用 `getVersion()` 判定「装上了」还是「没装上」，分别给成功提示与
 * 常驻错误提示——即使安装器侧彻底失败，用户也不会看到「静默无反应」。
 *
 * 三条约定（与旧实现相同，保留原注释口径）：
 * - **探测失败静默**：启动时的更新检查失败对用户不可操作，不刷 toast；
 *   主动检查（设置「关于」段）例外，必须给反馈。
 * - **安装期间弹窗不关**（A1）：进度与终态必须看得见。
 * - **探测延后 1.5s**，不与首屏渲染抢资源。
 *
 * 跳过语义（PB）：
 * - X / Esc 只等于「本次暂不更新」，**永不**写持久标记；
 * - 持久标记只由「本次暂不更新」+ 勾选复选框写入（`gc:update:skip`）；
 * - 已跳过且版本未变时启动不再弹窗，但设置里保留主动检查与「恢复提示」。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { UpdateDialog, type UpdatePhase } from '../components/UpdateDialog';
import type { UpdateCheckState } from '../components/SettingsSections';
import { useToast } from '../components/Toast';
import {
  UPDATE_ENDPOINT,
  clearSkipRecord,
  readSkipRecord,
  shouldOfferUpdate,
  writeSkipRecord,
} from '../utils/updateSkip';
import {
  classifyPendingUpdate,
  clearPendingRecord,
  readPendingRecord,
  writePendingRecord,
} from '../utils/updatePending';

interface PendingUpdate {
  version: string;
  body: string;
}

const DEFAULT_RELEASE_NOTES = '修复已知问题，优化体验。';
const INSTALLING_STATUS = '正在安装，完成后会自动启动，请稍候…';
const RELEASE_PAGE_URL = 'https://github.com/ID-VerNe/gallery-culling/releases/latest';

export function useAutoUpdate() {
  const [pending, setPending] = useState<PendingUpdate | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>('idle');
  const [status, setStatus] = useState('');
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skipChecked, setSkipChecked] = useState(false);
  const [skippedVersion, setSkippedVersion] = useState<string | null>(
    () => readSkipRecord()?.version ?? null,
  );
  const [checkState, setCheckState] = useState<UpdateCheckState>({ status: 'idle' });
  const [currentVersion, setCurrentVersion] = useState<string>('');

  /** 当前待安装的 update 句柄；撤销跳过时要靠它重新打开弹窗。 */
  const updateRef = useRef<Update | null>(null);
  /** 最近一次远端发现的条目（即使被跳过也记着，供「恢复提示」用）。 */
  const lastRemoteRef = useRef<PendingUpdate | null>(null);

  const toast = useToast();
  /** 让启动判定只跑一次：不因 toast 引用变化而重跑（重跑会误判本次刚写的记录）。 */
  const toastRef = useRef(toast);
  toastRef.current = toast;

  useEffect(() => {
    let alive = true;
    // **只在挂载时取一次**：本次会话里点安装写下的记录属于「下一次启动」，
    // 不能被本次启动的判定顺手清掉（否则真机装完就没法区分成败了）。
    const recordAtStartup = readPendingRecord();
    getVersion()
      .then((v) => {
        if (!alive) return;
        setCurrentVersion(v);
        // 兜底（#49-PB）：上次安装是否真的落到了目标版本？
        const outcome = classifyPendingUpdate(recordAtStartup, v);
        if (outcome === 'none') return;
        clearPendingRecord();
        if (outcome === 'completed') {
          toastRef.current.success(`已升级到 v${v}`);
        } else if (recordAtStartup) {
          // 错误级 toast 不自动消失：用户必须看到「没装上」以及下一步怎么做。
          toastRef.current.error(
            `上次升级未完成：目标是 v${recordAtStartup.targetVersion}，当前仍是 v${v}。` +
              '请到「设置 → 关于」重新检查更新，或打开发布页手动安装。',
          );
        }
      })
      .catch((err) => {
        console.error('Failed to read app version:', err);
      });
    return () => {
      alive = false;
    };
  }, []);

  const openUpdate = useCallback((update: Update) => {
    const entry: PendingUpdate = {
      version: update.version,
      body: update.body || DEFAULT_RELEASE_NOTES,
    };
    updateRef.current = update;
    lastRemoteRef.current = entry;
    setPending(entry);
    setPhase('idle');
    setStatus('');
    setPercent(null);
    setError(null);
    setSkipChecked(false);
  }, []);

  const runCheck = useCallback(
    async (manual: boolean) => {
      if (manual) setCheckState({ status: 'checking' });
      try {
        const update = await check();
        if (!update) {
          if (manual) setCheckState({ status: 'latest', version: currentVersion || '—' });
          return;
        }
        const record = readSkipRecord();
        if (!shouldOfferUpdate(update.version, record, UPDATE_ENDPOINT)) {
          // 记下句柄与条目：「恢复提示」要能凭它重新打开弹窗，不必再联网。
          updateRef.current = update;
          lastRemoteRef.current = {
            version: update.version,
            body: update.body || DEFAULT_RELEASE_NOTES,
          };
          setSkippedVersion(update.version);
          if (manual) setCheckState({ status: 'skipped', version: update.version });
          return;
        }
        setCheckState(manual ? { status: 'found', version: update.version } : { status: 'idle' });
        openUpdate(update);
      } catch (err) {
        if (manual) {
          // 主动检查必须给反馈，文案只放原始错误；「怎么办」由 AboutSection 统一给。
          setCheckState({ status: 'error', error: String(err) });
        } else {
          // Silent by design: a failed update check is not actionable for the user.
          console.error('Failed to check for updates:', err);
        }
      }
    },
    [currentVersion, openUpdate],
  );

  // 启动探测只跑一次；用 ref 拿最新的 runCheck，避免 currentVersion 回填时重排定时器。
  const runCheckRef = useRef(runCheck);
  runCheckRef.current = runCheck;
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void runCheckRef.current(false);
    }, 1500);
    return () => window.clearTimeout(timer);
  }, []);

  const install = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;

    setPhase('downloading');
    setStatus('正在准备下载…');
    setPercent(null);
    setError(null);

    // 兜底（#49-PB）：先留痕再动手。Windows 上进程随后会被 exit(0)，
    // 没有这条记录，下次启动就无法区分「升级成功」与「装完没人拉起」。
    writePendingRecord(currentVersion, update.version);

    let downloaded = 0;
    let total: number | null = null;
    try {
      // `restartAfterInstall: false`：关掉模板 `.onInstSuccess` 的 `/R`
      // （updater.rs:890-903 只有 true 才追加 `/R`）。重启改由
      // `src-tauri/nsis/update-hooks.nsh` 显式接管，它检查 RunAsUser 返回值
      // 并有 explorer / MessageBox 两层兜底；两边都开会各拉起一次。
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? null;
          setStatus('正在下载…');
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          if (total) {
            const next = Math.min(100, Math.round((downloaded / total) * 100));
            setPercent(next);
            setStatus(`正在下载 ${next}%`);
          } else {
            setStatus('正在下载…');
          }
        } else if (event.event === 'Finished') {
          // 终态：Windows 上安装器接管后进程会被 exit(0)，Promise 不会 resolve。
          setPercent(null);
          setPhase('installing');
          setStatus(INSTALLING_STATUS);
        }
      }, { restartAfterInstall: false });
      // 只有非 Windows（Promise 会 resolve）才可能走到这里；保持同一终态文案。
      setPercent(null);
      setPhase('installing');
      setStatus(INSTALLING_STATUS);
    } catch (err) {
      console.error('Failed to install update:', err);
      // 下载/启动安装器就失败了，安装器根本没跑，别让下次启动误报「上次升级未完成」。
      clearPendingRecord();
      setPhase('failed');
      setPercent(null);
      setStatus('');
      setError(`升级失败：${String(err)}。请检查网络后重试，或打开发布页手动安装。`);
    }
  }, [currentVersion]);

  const installNow = useCallback(() => {
    void install();
  }, [install]);

  const isBusy = phase === 'downloading' || phase === 'installing';

  /** X / Esc：只影响本次，绝不写持久标记。 */
  const dismiss = useCallback(() => {
    if (isBusy) return;
    setPending(null);
  }, [isBusy]);

  /** 「本次暂不更新」：勾了复选框才写 `gc:update:skip`。 */
  const later = useCallback(() => {
    if (isBusy) return;
    if (skipChecked && pending) {
      writeSkipRecord(pending.version);
      setSkippedVersion(pending.version);
    }
    setPending(null);
  }, [isBusy, pending, skipChecked]);

  /** 主动检查（设置「关于」段）。 */
  const checkNow = useCallback(() => runCheck(true), [runCheck]);

  /** 撤销跳过：清记录，并立刻用缓存的重开弹窗。 */
  const restoreSkipped = useCallback(() => {
    clearSkipRecord();
    setSkippedVersion(null);
    setCheckState({ status: 'idle' });
    if (lastRemoteRef.current && updateRef.current) {
      setPending(lastRemoteRef.current);
      setPhase('idle');
      setStatus('');
      setPercent(null);
      setError(null);
      setSkipChecked(false);
    }
  }, []);

  /** 更新提示弹窗。调用方直接放进 JSX 即可。 */
  const dialog = (
    <UpdateDialog
      isOpen={pending !== null}
      version={pending?.version ?? ''}
      body={pending?.body ?? ''}
      phase={phase}
      progressText={status}
      progressPercent={percent}
      error={error}
      skipChecked={skipChecked}
      onSkipCheckedChange={setSkipChecked}
      onInstall={installNow}
      onLater={later}
      onClose={dismiss}
      onRetry={installNow}
      onOpenReleasePage={() => {
        void openUrl(RELEASE_PAGE_URL);
      }}
    />
  );

  return {
    dialog,
    updateBusy: isBusy,
    updateStatus: status,
    pendingVersion: pending?.version ?? null,
    phase,
    error,
    skipChecked,
    setSkipChecked,
    skippedVersion,
    checkState,
    currentVersion,
    install: installNow,
    later,
    dismiss,
    checkNow,
    restoreSkipped,
  };
}
