@echo off
title Work Calendar Dev
cd /d E:\ai\work-calendar

start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:5173/"
npm run dev
