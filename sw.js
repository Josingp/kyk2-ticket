'use strict';
/* ============================================================
   sw.js — 오프라인·저속망 대응 서비스 워커
   - 앱 셸(페이지·스크립트·폰트)을 캐시해 현장에서 인터넷이 끊기거나
     느려도 티켓 화면이 열리게 한다.
   - /api/db 는 네트워크 우선(4초 제한) → 실패 시 마지막 캐시본 사용.
     즉, 한 번이라도 접속했던 기기는 완전 오프라인에서도 티켓 조회가 된다.
   - 체크인 등 나머지 API는 항상 네트워크 (상태 정합성 유지).
   ============================================================ */
const VER = 'kyk2-v32';  /* 비표 대상자 안내 팝업 추가 */
const SHELL = [
  './',
  './index.html',
  './verify.html',
  './assets/config.js',
  './assets/ticket-crypto.js',
  './assets/venue-jc.js',
  './assets/logo.png',
  './assets/qrcode.min.js',
  'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VER).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VER).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function timeout(ms) {
  return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
}

/* 네트워크 우선(제한시간) → 캐시, 성공하면 캐시 갱신 */
async function networkFirst(req, ms, cacheKey) {
  const cache = await caches.open(VER);
  try {
    const res = await Promise.race([fetch(req), timeout(ms)]);
    if (res && res.ok) cache.put(cacheKey || req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(cacheKey || req, { ignoreVary: true });
    if (hit) return hit;
    throw err;
  }
}

/* 캐시 우선 + 백그라운드 갱신 */
async function cacheFirst(req) {
  const cache = await caches.open(VER);
  const hit = await cache.match(req, { ignoreVary: true });
  const refresh = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return hit || refresh.then((res) => { if (!res) throw new Error('offline'); return res; });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;   // 체크인·발행 등 POST는 그대로 네트워크
  const url = new URL(req.url);

  /* /api/db 는 더 이상 전체 블롭을 공개 캐시하지 않는다.
     관람객·스태프 조회는 본인 레코드 1건만 POST로 받고(오프라인은 각 화면이 localStorage로 처리),
     전체 블롭 GET은 관리자/스태프 세션 전용(no-store)이므로 캐시 대상이 아니다. */
  if (url.pathname.startsWith('/api/')) return;   // 모든 API는 네트워크(개입하지 않음)

  /* 페이지 이동: 새 배포가 우선 반영되도록 네트워크 우선 → 오프라인이면 캐시 */
  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(req, 5000));
    return;
  }

  /* 정적 자원(스크립트·폰트·이미지): 캐시 우선 */
  if (url.origin === location.origin || url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'cdn.sheetjs.com') {
    e.respondWith(cacheFirst(req));
  }
});
