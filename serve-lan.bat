@echo off
rem Double-click to serve Slop Kahramanmaras to the local network (see serve-lan.py)
cd /d "%~dp0"
python serve-lan.py %*
pause
