'use strict';
/* ============================================================
   POST /api/admin — 운영자 전용 (비밀번호 서버 검증)
   body: { pw, event, action, db?, roster? }

   action
   - verify  : 비밀번호 확인만
   - roster  : 서버에 저장된 명단(평문, Redis 내부에만 존재) 반환
   - publish : 새 DB(암호문) + 명단을 Redis에 저장 → 즉시 반영
   ============================================================ */
const { redis, sanitizeEvent, checkPw, pwBlocked, notePwFail, readBody, getRosterCached, bustEvent,
  encryptStr, dataKey, makeSession, checkSession, verifyTotp, totpOn } = require('./_lib');

const MAX_BYTES = 950000; // Upstash 요청 한도(1MB) 보호

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const body = readBody(req);
  const ev = sanitizeEvent(body.event);
  if (!ev) { res.status(400).json({ error: 'bad_event' }); return; }

  try {
    /* 인증: 세션 토큰(역할 포함) 또는 비밀번호(+관리자 OTP) */
    let role = checkSession(body.tk);
    if (!role) {
      if (await pwBlocked(req)) { res.status(429).json({ error: 'too_many_attempts' }); return; }
      if (!checkPw(body.pw)) { await notePwFail(req); res.status(401).json({ error: 'unauthorized' }); return; }
      if (body.scope === 'staff') role = 's';
      else if (!totpOn()) role = 'a';
      else if (verifyTotp(body.otp)) role = 'a';
      else { await notePwFail(req); res.status(401).json({ error: 'otp_required' }); return; }
    }
    const isAdmin = role === 'a';

    const K = 'tickets:' + ev;

    if (body.action === 'verify') {
      /* DATA_KEY 설정 시 세션 토큰 발급 → 브라우저에 비밀번호를 남기지 않음
         관리자 6시간, 스태프 12시간(행사 당일 재로그인 최소화) */
      res.status(200).json({ ok: true, role: role,
        session: makeSession(isAdmin ? 6 : 12, role),
        otpRequired: totpOn(), encrypted: !!dataKey() });
      return;
    }

    /* 이하 명단·발행·파기는 관리자 전용 */
    if (!isAdmin) { res.status(403).json({ error: 'forbidden' }); return; }

    if (body.action === 'roster') {
      const roster = await getRosterCached(ev, 5000);
      res.status(200).json({ ok: true, roster, encrypted: !!dataKey() });
      return;
    }

    /* 데이터 파기 — 행사 종료 후 개인정보 파기 의무 이행용 */
    if (body.action === 'destroy') {
      for (const k of ['db', 'roster', 'checkin', 'share'])
        await redis(['DEL', K + ':' + k]);
      bustEvent(ev);
      res.status(200).json({ ok: true });
      return;
    }

    if (body.action === 'publish') {
      const db = body.db, roster = body.roster;
      if (!db || typeof db !== 'object' || !db.records || !db.verify) {
        res.status(400).json({ error: 'bad_db' }); return;
      }
      const dbStr = JSON.stringify(db);
      const roStr = JSON.stringify(roster || null);
      if (dbStr.length > MAX_BYTES || roStr.length > MAX_BYTES) {
        res.status(413).json({ error: 'too_big' }); return;
      }
      await redis(['SET', K + ':db', dbStr]);
      await redis(['SET', K + ':roster', encryptStr(roStr)]);
      bustEvent(ev);
      res.status(200).json({ ok: true, people: roster && roster.people ? roster.people.length : null,
        records: Object.keys(db.records).length, encrypted: !!dataKey() });
      return;
    }

    res.status(400).json({ error: 'bad_action' });
  } catch (e) {
    const msg = String(e && e.message || e);
    res.status(500).json({ error: msg === 'REDIS_ENV_MISSING' ? 'redis_env_missing' : 'server_error' });
  }
};
