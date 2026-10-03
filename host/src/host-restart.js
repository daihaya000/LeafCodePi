export function buildHostRestartScript({ lockFile, launcherExe, startBat, maxWaitAttempts = 120, relaunchGraceSeconds = 15 }) {
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
    // If the old host outlived the wait, the new one exits on the held lock and the old one then quits:
    // nothing is left running. Check once after a grace period and relaunch if no host owns the lock.
    `ping -n ${relaunchGraceSeconds + 1} 127.0.0.1 >nul`,
    'if exist "%LOCK%" goto :done',
    "if defined RELAUNCHED goto :done",
    'set "RELAUNCHED=1"',
    "goto :launch",
    ":done",
    "endlocal",
    'del "%~f0" >nul 2>&1',
  ];
}
