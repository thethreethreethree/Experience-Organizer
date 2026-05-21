@echo off
REM Experience Organizer launcher - starts the local server and opens the browser.
cd /d "%~dp0"

REM Free port 8000 if a previous server is still running (ignore errors).
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8000 " ^| findstr LISTENING') do taskkill /F /PID %%p >nul 2>&1

REM Check Node is available.
where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js was not found on your PATH.
  echo Install it from https://nodejs.org/ then run this again.
  pause
  exit /b 1
)

echo Starting Experience Organizer...
REM Open the browser ~2s later so the server is ready first (avoids connection-refused).
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:8000"

node server.mjs

echo.
echo Server stopped. Press any key to close.
pause >nul
