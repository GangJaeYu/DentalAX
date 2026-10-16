@echo off
chcp 65001 >nul
rem 이 파일이 하는 일: 처음 설치할 때 한 번 실행합니다. 필요한 부품을 설치하고 정상 동작을 확인합니다.
title DentalAX 설치
cd /d "%~dp0"

echo ==============================================
echo   DentalAX 설치를 시작합니다.
echo ==============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [1/3] Node.js가 없습니다. docs\GUIDE.md 의 "1단계: Node.js 설치"를 먼저 해 주세요.
  start "" "https://nodejs.org/ko/download"
  pause
  exit /b 1
)
echo [1/3] Node.js 확인:
node -v
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 (
  echo       버전이 낮습니다. nodejs.org 에서 LTS 버전^(24 이상 권장^)을 설치해 주세요.
  pause
  exit /b 1
)

echo.
echo [2/3] 필요한 부품 설치 중... (인터넷 필요, 1~2분)
call npm install --omit=dev --no-audit --no-fund
if errorlevel 1 (
  echo       설치에 실패했습니다. 인터넷 연결을 확인하고 다시 실행해 주세요.
  pause
  exit /b 1
)

echo.
echo [3/3] 동작 확인 중...
node --disable-warning=ExperimentalWarning -e "require('node:sqlite'); require('express'); console.log('      확인 완료')"
if errorlevel 1 (
  echo       확인에 실패했습니다. docs\GUIDE.md 의 "문제 해결"을 참고하세요.
  pause
  exit /b 1
)

echo.
echo ==============================================
echo   설치가 끝났습니다!
echo   이제 start.bat 을 더블클릭해서 서버를 켜세요.
echo   (처음 켤 때 "Windows 보안 경고"가 뜨면 [허용]을 눌러 주세요.
echo    그래야 직원 PC·태블릿에서 접속할 수 있습니다.)
echo ==============================================
pause
