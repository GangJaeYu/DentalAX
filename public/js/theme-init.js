/* 이 파일이 하는 일: 화면이 그려지기 전에 라이트/다크 모드를 먼저 정해서, 켤 때 화면이 번쩍이지 않게 합니다. */
(function () {
  try {
    var saved = localStorage.getItem('dx-theme');
    var dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
