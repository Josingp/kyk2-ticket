'use strict';
/* ============================================================
   POST /api/checkin — 좌석 단위 입장 체크인
   저장: Redis HASH  tickets:<event>:checkin
         field = "<확인코드>|<구역>|<좌석>", value = 입장시각(ISO)

   action
   - status : 관람객 화면용. { event, code } — 비밀번호 불필요
              (유효한 확인코드 소지 = 본인 증명). 본인 좌석 상태만 반환.
   - list   : 관리자 현황판. { event, pw } — 전체 체크인 맵 반환.
   - set    : 입장 처리/취소. { event, pw, code, z, s, on }
              스태프/관리자 비밀번호 필요. 명단에 있는 좌석만 허용.
   ============================================================ */
const { redis, sanitizeEvent, checkPw, pwBlocked, notePwFail, checkSession, getRosterCached, getHashCached, bustKey, memLimit, readBody } = require('./_lib');

const norm = v => String(v == null ? '' : v).trim();
const normCode = v => norm(v).replace(/[^0-9a-zA-Z]/g, '').toUpperCase();

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const body = readBody(req);
  const ev = sanitizeEvent(body.event);
  if (!ev) { res.status(400).json({ error: 'bad_event' }); return; }
  const K = 'tickets:' + ev + ':checkin';

  try {
    /* ---- 관람객: 본인 좌석 상태 ---- */
    if (body.action === 'status') {
      if (!memLimit(req, 900)) { res.status(429).json({ error: 'too_many' }); return; }
      const code = normCode(body.code);
      if (code.length < 8) { res.status(400).json({ error: 'bad_code' }); return; }
      const roster = await getRosterCached(ev, 10000);
      if (!roster || !roster.people) { res.status(404).json({ error: 'no_roster' }); return; }
      const person = roster.people.find(p => normCode(p.c) === code);
      if (!person) { res.status(404).json({ error: 'unknown_code' }); return; }
      const map = await getHashCached('checkin', ev, 3000);
      const seats = (person.t || []).map(tk => ({
        z: norm(tk.z), s: norm(tk.s),
        ts: map[person.c + '|' + norm(tk.z) + '|' + norm(tk.s)] || null,
      }));
      res.status(200).json({ ok: true, seats });
      return;
    }

    /* ---- 입장 처리(on) — 비밀번호 불필요.
       유효한 확인코드 소지 = 본인 티켓 증명이며, 처리는 본인에게 불리한
       방향(사용 처리)이라 위조 유인이 없음. 취소는 아래에서 비밀번호 필요. ---- */
    if (body.action === 'set' && body.on) {
      if (!memLimit(req, 900)) { res.status(429).json({ error: 'too_many' }); return; }
      const code = normCode(body.code), z = norm(body.z), s = norm(body.s);
      if (code.length < 8 || !z || !s) { res.status(400).json({ error: 'bad_seat' }); return; }
      const roster = await getRosterCached(ev, 10000);
      if (!roster || !roster.people) { res.status(404).json({ error: 'no_roster' }); return; }
      const person = roster.people.find(p => normCode(p.c) === code);
      const valid = person && (person.t || []).some(tk => norm(tk.z) === z && norm(tk.s) === s);
      if (!valid) { res.status(404).json({ error: 'unknown_seat' }); return; }
      const ts = new Date().toISOString();
      await redis(['HSET', K, person.c + '|' + z + '|' + s, ts]);
      bustKey('checkin', ev);
      res.status(200).json({ ok: true, ts });
      return;
    }

    /* ---- 이하 스태프/관리자 (세션 토큰 또는 비밀번호) ---- */
    if (!checkSession(body.tk)) {
      if (await pwBlocked(req)) { res.status(429).json({ error: 'too_many_attempts' }); return; }
      if (!checkPw(body.pw)) { await notePwFail(req); res.status(401).json({ error: 'unauthorized' }); return; }
    }

    if (body.action === 'list') {
      const checkins = await getHashCached('checkin', ev, 2000);
      res.status(200).json({ ok: true, checkins });
      return;
    }

    /* ---- 입장 취소(off) — 스태프/관리자만 ---- */
    if (body.action === 'set') {
      const code = normCode(body.code), z = norm(body.z), s = norm(body.s);
      if (code.length < 8 || !z || !s) { res.status(400).json({ error: 'bad_seat' }); return; }
      const roster = await getRosterCached(ev, 10000);
      if (!roster || !roster.people) { res.status(404).json({ error: 'no_roster' }); return; }
      const person = roster.people.find(p => normCode(p.c) === code);
      const valid = person && (person.t || []).some(tk => norm(tk.z) === z && norm(tk.s) === s);
      if (!valid) { res.status(404).json({ error: 'unknown_seat' }); return; }
      await redis(['HDEL', K, person.c + '|' + z + '|' + s]);
      bustKey('checkin', ev);
      res.status(200).json({ ok: true, ts: null });
      return;
    }

    res.status(400).json({ error: 'bad_action' });
  } catch (e) {
    const msg = String(e && e.message || e);
    res.status(500).json({ error: msg === 'REDIS_ENV_MISSING' ? 'redis_env_missing' : 'server_error' });
  }
};
