'use strict';
/* ============================================================
   POST /api/admin — 운영자 전용 (비밀번호 서버 검증)
   body: { pw, event, action, db?, roster? }

   action
   - verify  : 비밀번호 확인만
   - roster  : 서버에 저장된 명단(평문, Redis 내부에만 존재) 반환
   - publish : 새 DB(암호문) + 명단을 Redis에 저장 → 즉시 반영
   ============================================================ */
const { redis, sanitizeEvent, checkPw, pwBlocked, notePwFail, readBody } = require('./_lib');

const MAX_BYTES = 950000; // Upstash 요청 한도(1MB) 보호

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const body = readBody(req);
  const ev = sanitizeEvent(body.event);
  if (!ev) { res.status(400).json({ error: 'bad_event' }); return; }

  try {
    if (await pwBlocked(req)) { res.status(429).json({ error: 'too_many_attempts' }); return; }
    if (!checkPw(body.pw)) { await notePwFail(req); res.status(401).json({ error: 'unauthorized' }); return; }

    const K = 'tickets:' + ev;

    if (body.action === 'verify') {
      res.status(200).json({ ok: true });
      return;
    }

    if (body.action === 'roster') {
      const v = await redis(['GET', K + ':roster']);
      let roster = null;
      if (v) { try { roster = JSON.parse(v); } catch (e) { roster = null; } }
      res.status(200).json({ ok: true, roster });
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
      await redis(['SET', K + ':roster', roStr]);
      res.status(200).json({ ok: true, people: roster && roster.people ? roster.people.length : null,
        records: Object.keys(db.records).length });
      return;
    }

    res.status(400).json({ error: 'bad_action' });
  } catch (e) {
    const msg = String(e && e.message || e);
    res.status(500).json({ error: msg === 'REDIS_ENV_MISSING' ? 'redis_env_missing' : 'server_error' });
  }
};
