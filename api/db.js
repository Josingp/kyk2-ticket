'use strict';
/* ============================================================
   /api/db — 티켓 DB 접근 (보안 강화판)

   POST /api/db  body:{ event, id, tk? }
     → 지정한 레코드 1건의 암호문만 반환. (관람객·스태프 조회 경로)
       전체 명단을 통째로 내주지 않으므로 오프라인 무차별 복호화가 불가.
       미인증 요청은 IP당 레이트리밋 → 무차별 대입은 온라인·저속·감사가능.
       유효 세션(관리자/스태프) 요청은 레이트리밋 면제(현장 대량 스캔 대비).

   GET  /api/db?event=<salt>&tk=<session>   (또는 헤더 x-ticket-session)
     → 전체 암호문 DB 반환. 관리자/스태프 세션 필수. (명단 병합·검증용)
   ============================================================ */
const { sanitizeEvent, getDbCached, redis, clientIp, readBody, checkSession, audit } = require('./_lib');

const REC_LIMIT = 30;      // 미인증 IP당 단건조회 허용 횟수(10분). 정상 조회 1~수회엔 충분, 대입은 차단.
const REC_WINDOW = 600;

/* Redis 기반 per-IP 카운터 — 서버리스 인스턴스와 무관하게 일관 적용 */
async function rateOk(req, tag, max, win) {
  try {
    const k = 'tickets:rl:' + tag + ':' + clientIp(req);
    const n = await redis(['INCR', k]);
    if (n === 1) await redis(['EXPIRE', k, String(win)]);
    return n <= max;
  } catch (e) { return true; }   // Redis 장애 시 서비스 지속 우선(가용성)
}

module.exports = async (req, res) => {
  /* ── 관람객·스태프: 단건 레코드 조회 ── */
  if (req.method === 'POST') {
    const body = readBody(req);
    const ev = sanitizeEvent(body.event);
    if (!ev) { res.status(400).json({ error: 'bad_event' }); return; }
    const id = String(body.id || '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(id)) { res.status(400).json({ error: 'bad_id' }); return; }

    const authed = !!checkSession(body.tk);   // 스태프/관리자면 레이트리밋 면제
    if (!authed && !(await rateOk(req, 'rec', REC_LIMIT, REC_WINDOW))) {
      audit(ev, 'rec_ratelimit', req, {});     // 대량 조회 시도는 흔적을 남긴다
      res.status(429).json({ error: 'too_many' }); return;
    }
    try {
      const val = await getDbCached(ev, 5000);
      if (!val) { res.setHeader('Cache-Control', 'no-store'); res.status(404).json({ error: 'empty' }); return; }
      let db; try { db = JSON.parse(val); } catch (e) { res.status(500).json({ error: 'server_error' }); return; }
      const box = (db.records && db.records[id]) || (db.verify && db.verify[id]) || null;
      /* 존재/부재 모두 200 + 동일 형태 → 존재 여부 오라클 최소화 */
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ ok: true, box: box, v: db.v || 1 });
    } catch (e) {
      const msg = String(e && e.message || e);
      res.status(500).json({ error: msg === 'REDIS_ENV_MISSING' ? 'redis_env_missing' : 'server_error' });
    }
    return;
  }

  /* ── 관리자/스태프: 전체 블롭 (세션 필수) ── */
  if (req.method === 'GET') {
    const ev = sanitizeEvent(req.query && req.query.event);
    if (!ev) { res.status(400).json({ error: 'bad_event' }); return; }
    const tk = (req.query && req.query.tk) || req.headers['x-ticket-session'] || '';
    if (!checkSession(tk)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const val = await getDbCached(ev, 5000);
      if (!val) { res.setHeader('Cache-Control', 'no-store'); res.status(404).json({ error: 'empty' }); return; }
      res.setHeader('Cache-Control', 'no-store');   // 인증 응답은 CDN 캐시 금지
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(200).send(val);
    } catch (e) {
      const msg = String(e && e.message || e);
      res.status(500).json({ error: msg === 'REDIS_ENV_MISSING' ? 'redis_env_missing' : 'server_error' });
    }
    return;
  }

  res.status(405).json({ error: 'method_not_allowed' });
};
