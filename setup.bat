@echo off
rem StashManager setup - runs setup.ps1 (args are passed through, e.g. setup.bat -Icons)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
pause
