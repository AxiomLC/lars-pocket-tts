@echo off
cd /d %~dp0
if not exist .env copy .env.example .env
:: read PORT from .env (falls back to 1122)
set PORT=1122
for /f "usebackq tokens=1,* delims==" %%a in (".env") do if /i "%%a"=="PORT" set PORT=%%b
start "" http://localhost:%PORT%
npm start
