@echo off
echo Requesting Administrator privileges to run build...
cd /d "%~dp0"
powershell -Command "Start-Process cmd -ArgumentList '/c cd /d %CD% && npm run dist && echo. && echo Build Complete! Output checks: && dir dist && pause' -Verb RunAs"
