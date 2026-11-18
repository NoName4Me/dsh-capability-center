@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "CAP_PYTHON="

if not "%CAPABILITY_CENTER_PYTHON%"=="" if exist "%CAPABILITY_CENTER_PYTHON%" set "CAP_PYTHON=%CAPABILITY_CENTER_PYTHON%"
if not defined CAP_PYTHON if not "%DSH_HOME%"=="" if exist "%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" set "CAP_PYTHON=%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
if not defined CAP_PYTHON if not "%USERPROFILE%"=="" if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" set "CAP_PYTHON=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
if not defined CAP_PYTHON if not "%LOCALAPPDATA%"=="" if exist "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\python\python.exe" set "CAP_PYTHON=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\python\python.exe"
if not defined CAP_PYTHON if not "%ProgramFiles%"=="" if exist "%ProgramFiles%\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\python\python.exe" set "CAP_PYTHON=%ProgramFiles%\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\python\python.exe"

if not defined CAP_PYTHON (
  where python.exe >nul 2>nul
  if not errorlevel 1 set "CAP_PYTHON=python.exe"
)
if not defined CAP_PYTHON (
  where py.exe >nul 2>nul
  if not errorlevel 1 set "CAP_PYTHON=py.exe"
)
if not defined CAP_PYTHON (
  echo [ERROR] Python 3 was not found. Set CAPABILITY_CENTER_PYTHON and retry.
  pause
  exit /b 2
)

echo Using Python: %CAP_PYTHON%
"%CAP_PYTHON%" -s "%~dp0start-server.py" %*
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" pause
exit /b %RESULT%
