$procs = Get-Process gallery-culling -ErrorAction SilentlyContinue
if (-not $procs) { Write-Output "NOT_RUNNING"; exit 0 }
foreach ($p in $procs) {
  $ok = $p.CloseMainWindow()
  Write-Output ("CloseMainWindow -> {0} (pid {1})" -f $ok, $p.Id)
}
