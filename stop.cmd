@echo off
chcp 65001 >nul
rem Stops whatever listens on the Meraki ports: backend :8000 and frontend :5173.
set found=
for %%p in (8000 5173) do (
  for /f "tokens=5" %%i in ('netstat -ano ^| findstr /r /c:":%%p .*LISTENING"') do (
    taskkill /PID %%i /T /F >nul 2>nul && echo Остановлен процесс %%i на порту %%p
    set found=1
  )
)
if not defined found echo Meraki не запущен.
