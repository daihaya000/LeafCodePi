@echo off
rem KEEP THIS FILE ASCII-ONLY (bytes 0x00-0x7F, CRLF, no BOM).
rem cmd.exe misparses batch files that contain multi-byte characters.
goto :main

:main
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
title LeafCodePi
call "%~dp0scripts\start-webui.bat"
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" exit /b %ERR%
exit /b 0
