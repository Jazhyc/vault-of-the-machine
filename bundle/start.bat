@echo off
title VAULT OF THE MACHINE
cd /d "%~dp0"
echo Starting VAULT OF THE MACHINE...
echo A public fireteam link will appear below. Keep this window open while you play.
echo.
"%~dp0node\node.exe" "%~dp0server\web.js"
echo.
echo Server stopped.
pause
