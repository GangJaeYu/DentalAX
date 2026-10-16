@echo off
chcp 65001 >nul
rem 이 파일이 하는 일: 관리자(또는 직원) 비밀번호를 잊었을 때 서버 PC에서 임시 비밀번호로 바꿉니다.
title DentalAX 비밀번호 초기화
cd /d "%~dp0"
node --disable-warning=ExperimentalWarning scripts\reset-password.js
pause
