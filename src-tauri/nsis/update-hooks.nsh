/*
 * 升级装完后的自动重启兜底（issue #49-PA）。
 *
 * 背景：Tauri 模板只在 `.onInstSuccess` 里调 `nsis_tauri_utils::RunAsUser`
 * （tauri-bundler 生成的 installer.nsi:1945-1956），**返回值不 Pop**。实测：
 * - 非提权安装器：RunAsUser 返回 0，应用能回来；
 * - 提权安装器：RunAsUser 返回 1（内部走复制壳进程 token 的路径失败），
 *   模板不检查 → 静默无反应，用户必须手动重开（issue #49 的现象）。
 *
 * 因此这里在「文件/注册表/快捷方式全部就绪之后」显式接管重启：
 * 1) 先 RunAsUser 并 Pop 返回值 —— 非提权时它以普通用户权限拉起，最干净；
 * 2) 失败则用 explorer.exe 走外壳兜底 —— 提权安装器里实测可用；
 * 3) 仍失败则弹出带「重试启动」的对话框，**不允许静默**。
 *
 * 挂载点：`src-tauri/tauri.conf.json` 的 `bundle.windows.nsis.installerHooks`。
 * 前端同时传 `restartAfterInstall: false`（`src/hooks/useAutoUpdate.tsx`），
 * 关掉模板 `.onInstSuccess` 的 `/R` 路径，避免两边各拉起一次。
 *
 * 只用 `$UpdateMode`（updater 传 `/UPDATE` 时才为 1），不影响用户手动双击
 * 安装包的完成页「运行应用」。
 */
!macro NSIS_HOOK_POSTINSTALL
  ${If} $UpdateMode = 1
    nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
    Pop $R0
    ${If} $R0 != 0
      retryLaunchApp:
        ClearErrors
        Exec '"$WINDIR\explorer.exe" "$INSTDIR\${MAINBINARYNAME}.exe"'
        ${If} ${Errors}
          ClearErrors
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "升级已完成，但应用未能自动启动。$\r$\n$\r$\n点「重试」再启动一次；点「取消」后仍可从开始菜单打开 ${PRODUCTNAME}。" IDRETRY retryLaunchApp
        ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
