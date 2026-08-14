'use strict';
/* ============================================================
   POST /api/share — 좌석 1매 선물(공유) 링크
   저장: Redis HASH  tickets:<event>:share
         token → {c,z,s,t}   /   "s|<code>|<z>|<s>" → token (재사용 인덱스)

   action
   - create  : { event, code, z, s }  소유자 인증 = 유효한 확인코드.
               좌석당 링크 1개(이미 있으면 재사용). → { token }
   - resolve : { event, token }  누구나(토큰 소지 = 수신자). 명단과 대조해
               해당 좌석만 반환. → { n, c, seat:{z,s,g} }
   - revoke  : { event, code, z, s }  소유자만. 링크 삭제(회수).
   ============================================================ */
const { redis, sanitizeEvent, softLimit, getRoster, readBody } = require('./_lib');
const crypto = require('node:crypto');

const norm = v => String(v == null ? '' : v).trim();
const normCode = v => norm(v).replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
const AB = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeToken(n){
  const b = crypto.randomBytes(n); let s = '';
  for (let i = 0; i < n; i++) s += AB[b[i] % AB.length];
  return s;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const body = readBody(req);
  const ev = sanitizeEvent(body.event);
  if (!ev) { res.status(400).json({ error: 'bad_event' }); return; }
  const K = 'tickets:' + ev + ':share';

  try {
    if (!(await softLimit(req, 900))) { res.status(429).json({ error: 'too_many' }); return; }

    /* ---- 수신자: 토큰으로 좌석 1매 조회 ---- */
    if (body.action === 'resolve') {
      const tok = normCode(body.token);
      if (tok.length < 8) { res.status(400).json({ error: 'bad_token' }); return; }
      const raw = await redis(['HGET', K, tok]);
      if (!raw) { res.status(404).json({ error: 'unknown_token' }); return; }
      let d = null;
      try { d = JSON.parse(raw); } catch (e) {}
      if (!d) { res.status(404).json({ error: 'unknown_token' }); return; }
      const roster = await getRoster(ev);
      if (!roster || !roster.people) { res.status(404).json({ error: 'no_roster' }); return; }
      const person = roster.people.find(p => normCode(p.c) === normCode(d.c));
      const seat = person && (person.t || []).find(tk => norm(tk.z) === d.z && norm(tk.s) === d.s);
      if (!seat) { res.status(404).json({ error: 'unknown_seat' }); return; }
      res.status(200).json({ ok: true, n: person.n, c: person.c,
        seat: { z: norm(seat.z), s: norm(seat.s), g: seat.g || undefined } });
      return;
    }

    /* ---- 이하 소유자(확인코드 인증) ---- */
    const code = normCode(body.code), z = norm(body.z), s = norm(body.s);
    if (code.length < 8 || !z || !s) { res.status(400).json({ error: 'bad_seat' }); return; }
    const roster = await getRoster(ev);
    if (!roster || !roster.people) { res.status(404).json({ error: 'no_roster' }); return; }
    const person = roster.people.find(p => normCode(p.c) === code);
    const valid = person && (person.t || []).some(tk => norm(tk.z) === z && norm(tk.s) === s);
    if (!valid) { res.status(404).json({ error: 'unknown_seat' }); return; }
    const seatKey = 's|' + person.c + '|' + z + '|' + s;

    if (body.action === 'create') {
      let tok = await redis(['HGET', K, seatKey]);
      if (!tok) {
        tok = makeToken(12);
        await redis(['HSET', K, seatKey, tok]);
        await redis(['HSET', K, tok, JSON.stringify({ c: person.c, z: z, s: s, t: Date.now() })]);
      }
      res.status(200).json({ ok: true, token: tok });
      return;
    }

    if (body.action === 'revoke') {
      const tok = await redis(['HGET', K, seatKey]);
      if (tok) { await redis(['HDEL', K, tok]); await redis(['HDEL', K, seatKey]); }
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: 'bad_action' });
  } catch (e) {
    const msg = String(e && e.message || e);
    res.status(500).json({ error: msg === 'REDIS_ENV_MISSING' ? 'redis_env_missing' : 'server_error' });
  }
};
