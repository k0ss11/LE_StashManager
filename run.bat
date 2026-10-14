@echo off
rem Start the StashManager local web server and open the page.
setlocal
if not exist "%~dp0.venv\Scripts\python.exe" (
  echo Run setup.bat first.
  pause
  exit /b 1
)
tasklist /FI "IMAGENAME eq Last Epoch.exe" | find /I "Last Epoch.exe" >nul || echo [warn] Last Epoch is not running - start the game, the page will connect when it is up.
start "" http://127.0.0.1:8100
"%~dp0.venv\Scripts\python.exe" -I "%~dp0host.py"
pause
