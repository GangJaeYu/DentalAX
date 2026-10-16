@echo off
chcp 65001 >nul
rem 이 파일이 하는 일: 켜져 있는 DentalAX 서버를 끕니다. (서버 검은 창을 닫아도 똑같이 꺼집니다)
cd /d "%~dp0"
for /f %%p in ('node -e "let p=3800;try{p=require('./config.json').port||3800}catch(e){};console.log(p)"') do set PORT=%%p
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue; if ($c) { $c.OwningProcess | Select-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force }; Write-Host '서버를 껐습니다.' } else { Write-Host '켜져 있는 서버가 없습니다.' }"
pause
