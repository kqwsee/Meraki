@echo off
chcp 65001 >nul
setlocal
title Meraki
cd /d "%~dp0"

rem Starts the backend (:8000) and the frontend (:5173) in their own windows and opens the site.
rem First run also installs dependencies. Stop: close both windows or run stop.cmd.

if not exist "backend\.env" (
  copy "backend\.env.example" "backend\.env" >nul
  echo [!] Создан backend\.env из шаблона. Проверьте в нём SECRET_KEY и настройки нейросети.
)

if not exist "backend\.venv\Scripts\python.exe" call :setup_backend || goto :fail
if not exist "frontend\node_modules" call :setup_frontend || goto :fail

call :running 8000 && echo Бэкенд уже запущен на :8000 || start "Meraki backend" /d "%~dp0backend" cmd /k ".venv\Scripts\python.exe -m uvicorn app.main:app --port 8000"
call :running 5173 && echo Фронтенд уже запущен на :5173 || start "Meraki frontend" /d "%~dp0frontend" cmd /k "npm run dev"

echo Жду, пока поднимется сайт...
set /a tries=0
:wait
curl -s -f -o nul http://127.0.0.1:8000/api/meta && curl -s -o nul http://localhost:5173 && goto :ready
set /a tries+=1
if %tries% geq 60 goto :slow
ping -n 2 127.0.0.1 >nul
goto :wait

:slow
echo [!] Сайт не ответил за минуту. Посмотрите ошибки в окнах "Meraki backend" и "Meraki frontend".
pause
exit /b 1

:ready
if not defined MERAKI_NO_BROWSER start "" http://localhost:5173
echo.
echo Meraki запущен: http://localhost:5173
echo Остановить: закройте окна "Meraki backend" и "Meraki frontend" или запустите stop.cmd
exit /b 0

:running
netstat -ano | findstr /r /c:":%1 .*LISTENING" >nul
exit /b %errorlevel%

:setup_backend
echo Устанавливаю зависимости бэкенда, это один раз...
where uv >nul 2>nul || (echo [!] Нужен uv: https://docs.astral.sh/uv/ & exit /b 1)
pushd backend
uv sync
set rc=%errorlevel%
popd
exit /b %rc%

:setup_frontend
echo Устанавливаю зависимости фронтенда, это один раз...
where npm >nul 2>nul || (echo [!] Нужен Node.js 20+: https://nodejs.org & exit /b 1)
pushd frontend
call npm install
set rc=%errorlevel%
popd
exit /b %rc%

:fail
echo [!] Запуск не удался, смотрите сообщения выше.
pause
exit /b 1
