export function buildHostRestartScript({ lockFile, launcherExe, startBat, maxWaitAttempts = 120 }) {
  const launchLine = launcherExe
    ? `start "LeafCodePi" /min "${launcherExe}"`
    : `start "LeafCodePi" /min cmd.exe /c ""${startBat}" >nul 2>&1"`;
  return [
    "@echo off",
    "setlocal",
    "set \"LEAFCODE_PI_SKIP_STALE_REBUILD=1\"",
    `set "LOCK=${lockFile}"`,
    "set /a WAIT=0",
    ":wait",
    'if not exist "%LOCK%" goto :launch',
    "set /a WAIT+=1",
    `if %WAIT% GEQ ${maxWaitAttempts} goto :launch`,
    "ping -n 2 127.0.0.1 >nul",
    "goto :wait",
    ":launch",
    launchLine,
    "endlocal",
    'del "%~f0" >nul 2>&1',
  ];
}
