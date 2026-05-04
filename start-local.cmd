@echo off
setlocal
cd /d "%~dp0"
echo Starting Etherpump local server on http://localhost:4173
echo Keep this window open while testing.
node backend\server.js

