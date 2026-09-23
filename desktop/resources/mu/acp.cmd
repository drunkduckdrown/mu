@echo off
rem mu's ACP adapter in the packaged app (Windows). AionCore runs this file as the command of mu's registration.
rem The adapter is bundled into app.asar.unpacked\out\main\mu-acp.js and checks the Node version itself.
rem Keep this file ASCII: cmd reads it in the console's code page.
node "%~dp0..\app.asar.unpacked\out\main\mu-acp.js" %*
exit /b %errorlevel%
