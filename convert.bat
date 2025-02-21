@echo off
if "%~1"=="" (
    echo Please drag an EPUB file onto this batch file.
    pause
    exit /b 1
)

if not "%~x1"==".epub" (
    echo The dropped file is not an EPUB file.
    pause
    exit /b 1
)

node "%~dp0index.js" "%~1"