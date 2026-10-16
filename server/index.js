/*
 * 이 파일이 하는 일: 서버를 실제로 켭니다. (start.bat 이 이 파일을 실행)
 *
 *  1) DB 준비  2) 웹 서버 시작  3) 자동 백업 예약  4) 접속 주소 안내 출력  5) (설정 시) 브라우저 열기
 */
const os = require('node:os');
const { execFile } = require('node:child_process');
const cfg = require('./core/config');
const { init, createApp } = require('./app');
const backup = require('./core/backup');
const auth = require('./core/auth');

/**
 * 이 PC의 원내 IP 주소 목록 (직원 PC·태블릿에서 접속할 주소)
 * 가상 네트워크(WSL, Hyper-V, VirtualBox 등)는 직원 기기에서 접속할 수 없는 주소라 뒤로 보내거나 뺍니다.
 */
function lanAddresses() {
  const VIRTUAL = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Docker|Loopback|vbox|virbr|tailscale|zerotier/i;
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) found.push({ name, address: a.address, virtual: VIRTUAL.test(name) });
    }
  }
  const real = found.filter((f) => !f.virtual);
  const pick = real.length ? real : found;
  // 공유기에서 흔한 192.168.x.x 주소를 맨 앞에
  pick.sort((a, b) => (b.address.startsWith('192.168.') ? 1 : 0) - (a.address.startsWith('192.168.') ? 1 : 0));
  return pick.map((f) => f.address);
}

function main() {
  const config = cfg.config;
  const file = init();
  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    const ips = lanAddresses();
    console.log('');
    console.log('==============================================');
    console.log('  DentalAX 서버가 켜졌습니다.');
    console.log(`  이 PC에서:      http://localhost:${config.port}`);
    for (const ip of ips) console.log(`  직원 PC·태블릿: http://${ip}:${config.port}`);
    console.log(`  데이터 파일:    ${file}`);
    console.log('  이 창을 닫으면 서버가 꺼집니다. (최소화해 두세요)');
    console.log('==============================================');
    console.log('');
    if (config.openBrowser && process.platform === 'win32') {
      execFile('cmd', ['/c', 'start', '', `http://localhost:${config.port}`], () => {});
    }
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\n[오류] ${config.port}번 포트를 이미 다른 프로그램이 쓰고 있습니다.`);
      console.error('  - DentalAX가 이미 켜져 있는지 확인하세요 (다른 검은 창).');
      console.error('  - 또는 config.json 의 "port" 값을 바꾸세요. (docs/GUIDE.md 의 문제 해결 참고)\n');
    } else {
      console.error('[오류] 서버를 시작하지 못했습니다:', e.message);
    }
    process.exit(1);
  });

  backup.startScheduler();
  // 1시간마다 만료된 로그인 정리
  setInterval(() => auth.purgeExpiredSessions(), 3600 * 1000).unref();

  const shutdown = () => {
    console.log('\n서버를 끕니다...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = { lanAddresses };
