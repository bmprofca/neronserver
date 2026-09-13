@echo off
title Neron 20 LAN Agent
cd /d "%~dp0"

set "EXE="
if exist "%~dp0NeronLanAgent.exe" set "EXE=%~dp0NeronLanAgent.exe"
if exist "%~dp0dist\NeronLanAgent.exe" set "EXE=%~dp0dist\NeronLanAgent.exe"

if not exist "%~dp0NeronLanAgent.env" if exist "%~dp0NeronLanAgent.env.example" (
  echo Creating NeronLanAgent.env from example — edit API_KEY before use.
  copy /Y "%~dp0NeronLanAgent.env.example" "%~dp0NeronLanAgent.env" >nul
)

if defined EXE (
  echo Starting %EXE%
  echo Config: %~dp0NeronLanAgent.env
  echo Keep this window open. Ctrl+C to stop.
  echo.
  "%EXE%"
  goto :eof
)

if not exist "%~dp0.env" if exist "%~dp0NeronLanAgent.env" (
  copy /Y "%~dp0NeronLanAgent.env" "%~dp0.env" >nul
)

if not exist "%~dp0.env" (
  echo Missing NeronLanAgent.env — paste your API key, then run again.
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not found and no .exe built.
  echo Install Node from https://nodejs.org or run: npm run agent:build-exe
  pause
  exit /b 1
)

cd /d "%~dp0.."
echo Starting via Node npm run agent ...
call npm run agent
pause
