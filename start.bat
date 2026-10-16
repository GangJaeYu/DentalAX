@echo off
chcp 65001 >nul
rem 이 파일이 하는 일: DentalAX 서버를 켭니다. (매일 이 파일을 더블클릭)
rem   - Node.js가 없으면 설치 안내를 띄웁니다.
rem   - 처음 한 번은 필요한 부품(express)을 자동으로 설치합니다.
rem   - 서버가 켜지면 브라우저가 자동으로 열립니다. 이 검은 창을 닫으면 서버가 꺼집니다.
title DentalAX 서버 (이 창을 닫으면 서버가 꺼집니다)
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [안내] Node.js가 설치되어 있지 않습니다.
  echo        docs\GUIDE.md 의 "1단계: Node.js 설치"를 따라 설치한 뒤 다시 실행해 주세요.
  echo        잠시 후 Node.js 다운로드 페이지를 엽니다.
  echo.
  start "" "https://nodejs.org/ko/download"
  pause
  exit /b 1
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 (
  echo.
  echo [안내] Node.js 버전이 너무 낮습니다. 지금 버전:
  node -v
  echo        nodejs.org 에서 LTS 버전을 다시 설치해 주세요. ^(22 이상 필요, 24 LTS 권장^)
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\express\package.json" (
  echo.
  echo 처음 실행이라 필요한 부품을 설치합니다. 인터넷 연결이 필요합니다. 1~2분 걸릴 수 있습니다...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo [오류] 부품 설치에 실패했습니다. 인터넷 연결을 확인하고 다시 실행해 주세요.
    echo        계속 실패하면 docs\GUIDE.md 의 "문제 해결"을 참고하세요.
    pause
    exit /b 1
  )
)

node --disable-warning=ExperimentalWarning server\index.js
echo.
echo 서버가 멈췄습니다. 위에 나온 안내를 확인해 주세요.
pause
