@echo off
rem KEEP THIS FILE ASCII-ONLY (bytes 0x00-0x7F, CRLF, no BOM).
rem Run the approved exclusive cutover: the Host starts the independent Backend, hands the Pi
rem runtime over and brings the WebUI back as a client. Run it while no task is in flight: the
rem cutover refuses to start otherwise, and stopping the WebUI would end those sessions.
setlocal EnableExtensions DisableDelayedExpansion
if not defined LEAFCODE_PI_BACKEND set "LEAFCODE_PI_BACKEND=1"
if not defined LEAFCODE_PI_CUTOVER set "LEAFCODE_PI_CUTOVER=1"
echo [LeafCodePi] Cutover requested: starting the Host with the Backend enabled.
call "%~dp0start-webui.bat"
set ERR=%ERRORLEVEL%
exit /b %ERR%
