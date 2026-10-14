@echo off
rem Start the StashManager web server and open the page.
rem   run.bat              this PC only (http://127.0.0.1:8100)
rem   run.bat lan          also other devices in your network (access key required, link printed below)
rem   run.bat 192.168.1.20 bind one specific address of this PC
setlocal
if not exist "%~dp0.venv\Scripts\python.exe" (
  echo Run setup.bat first.
  pause
  exit /b 1
)
tasklist /FI "IMAGENAME eq Last Epoch.exe" | find /I "Last Epoch.exe" >nul || echo [warn] Last Epoch is not running - start the game, the page will connect when it is up.
set "ARGS="
set "OPEN=http://127.0.0.1:8100"
if /I "%~1"=="lan" set "ARGS=--lan"
if not "%~1"=="" if /I not "%~1"=="lan" (
  set "ARGS=--host %~1"
  set "OPEN=http://%~1:8100"
)
start "" %OPEN%
"%~dp0.venv\Scripts\python.exe" -I "%~dp0host.py" %ARGS%
pause
