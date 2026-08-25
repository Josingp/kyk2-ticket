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

   ※ 양도 제한: 명단 기준 1매만 받은 사람은 링크를 만들 수 없고(create 403),
      이미 만들어진 링크도 열리지 않는다(resolve 403, error: 'not_transferable').
   ============================================================ */
const { redis, sanitizeEvent, getRosterCached, getHashCached, bustKey, memLimit, readBody } = require('./_lib');
const crypto = require('node:crypto');
const CFG = require('../assets/config.js');

const norm = v => String(v == null ? '' : v).trim();
const normCode = v => norm(v).replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
const AB = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const TTL_MS = 6 * 3600000;   // 생성 후 최소 유효시간 6시간
/* 만료 시각 = max(행사 종료 시각(config.schedule.end), 생성 + 6시간)
   → 행사 전에 미리 보낸 링크는 경기 당일 종료까지 살아 있고, 종료 후에 만든 링크만 6시간 뒤 만료된다. */
const EVENT_END_MS = Date.parse((CFG.schedule || {}).end || '') || 0;
function expiresAt(t0) { return Math.max(EVENT_END_MS, (+t0 || 0) + TTL_MS); }
function expired(d) { return !d || !d.t || Date.now() > expiresAt(d.t); }
/* 2매 이상 받은 사람만 좌석을 나눠 보낼 수 있다 (1매 = 본인 외 사용 불가) */
function transferable(person) { return Array.isArray(person && person.t) && person.t.length >= 2; }
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
    if (!memLimit(req, 6000)) { res.status(429).json({ error: 'too_many' }); return; }   /* IP 광역 상한 — 행사장 NAT 대응 */

    /* ---- 수신자: 토큰으로 좌석 조회 (1매 또는 묶음) ----
       폭파 방지: 명단 수정으로 일부 좌석이 바뀌어도 남은 좌석만으로 링크가 살아있고,
       빠진 수(missing)를 알려 수신자에게 안내한다. */
    if (body.action === 'resolve') {
      const tok = normCode(body.token);
      if (tok.length < 8) { res.status(400).json({ error: 'bad_token' }); return; }
      if (!memLimit(req, 120, 'tk:' + tok)) { res.status(429).json({ error: 'too_many' }); return; }
      const shareMap = await getHashCached('share', ev, 10000);
      const raw = shareMap[tok];
      if (!raw) { res.status(404).json({ error: 'unknown_token' }); return; }
      let d = null;
      try { d = JSON.parse(raw); } catch (e) {}
      if (!d) { res.status(404).json({ error: 'unknown_token' }); return; }
      /* 행사 종료(또는 생성 후 6시간) 경과 → 만료 (지연 정리 포함) */
      if (expired(d)) {
        try {
          await redis(['HDEL', K, tok]);
          if (d.k) await redis(['HDEL', K, d.k]);
          bustKey('share', ev);
        } catch (e) {}
        res.status(410).json({ error: 'expired' });
        return;
      }
      const wanted = Array.isArray(d.seats) ? d.seats : [{ z: d.z, s: d.s }];   // 구버전 토큰 호환
      const roster = await getRosterCached(ev, 10000);
      if (!roster || !roster.people) { res.status(404).json({ error: 'no_roster' }); return; }
      const person = roster.people.find(p => normCode(p.c) === normCode(d.c));
      if (!person) { res.status(404).json({ error: 'unknown_seat' }); return; }
      /* 1매 초대자는 양도 불가 — 이전에 만든 링크가 남아 있어도 열리지 않게 현재 명단 기준으로 차단 */
      if (!transferable(person)) { res.status(403).json({ error: 'not_transferable' }); return; }
      const found = [];
      wanted.forEach(w => {
        const seat = (person.t || []).find(tk => norm(tk.z) === norm(w.z) && norm(tk.s) === norm(w.s));
        if (seat) found.push({ z: norm(seat.z), s: norm(seat.s), g: seat.g || undefined, b: seat.b || undefined });
      });
      if (!found.length) { res.status(404).json({ error: 'unknown_seat' }); return; }
      res.status(200).json({ ok: true, n: person.n, c: person.c,
        seats: found, missing: wanted.length - found.length });
      return;
    }

    /* ---- 이하 소유자(확인코드 인증) — 좌석 1매 또는 여러 매(seats 배열) ---- */
    const code = normCode(body.code);
    let seats = Array.isArray(body.seats)
      ? body.seats.map(w => ({ z: norm(w && w.z), s: norm(w && w.s) }))
      : [{ z: norm(body.z), s: norm(body.s) }];
    seats = seats.filter(w => w.z && w.s);
    if (code.length < 8 || !seats.length || seats.length > 40) { res.status(400).json({ error: 'bad_seat' }); return; }
    const roster = await getRosterCached(ev, 10000);
    if (!roster || !roster.people) { res.status(404).json({ error: 'no_roster' }); return; }
    const person = roster.people.find(p => normCode(p.c) === code);
    const allValid = person && seats.every(w =>
      (person.t || []).some(tk => norm(tk.z) === w.z && norm(tk.s) === w.s));
    if (!allValid) { res.status(404).json({ error: 'unknown_seat' }); return; }
    /* 1매 초대자는 선물 링크 생성 불가 (삭제는 정리용으로 허용) */
    if (body.action === 'create' && !transferable(person)) { res.status(403).json({ error: 'not_transferable' }); return; }
    /* 좌석당/조합당 링크 1개: 같은 조합이면 항상 같은 토큰 (단일 좌석은 기존 키 유지) */
    const seatKey = seats.length === 1
      ? 's|' + person.c + '|' + seats[0].z + '|' + seats[0].s
      : 'm|' + person.c + '|' + seats.map(w => w.z + '\u241F' + w.s).sort().join('\u241E');

    if (body.action === 'create') {
      let tok = await redis(['HGET', K, seatKey]);
      let exp = null;
      if (tok) {
        /* 기존 토큰이 만료됐으면 폐기하고 새로 발급 */
        const raw0 = await redis(['HGET', K, tok]);
        let d0 = null;
        try { d0 = raw0 ? JSON.parse(raw0) : null; } catch (e) {}
        if (expired(d0)) {
          await redis(['HDEL', K, tok]);
          await redis(['HDEL', K, seatKey]);
          bustKey('share', ev);
          tok = null;
        } else {
          exp = expiresAt(d0.t);
        }
      }
      if (!tok) {
        /* 두 기기가 동시에 생성해도 토큰은 하나만: 먼저 기록한 쪽이 승자 */
        const cand = makeToken(12);
        const won = await redis(['HSETNX', K, seatKey, cand]);
        const t0 = Date.now();
        if (won === 1 || won === '1') {
          await redis(['HSET', K, cand, JSON.stringify({ c: person.c, seats: seats, t: t0, k: seatKey })]);
          tok = cand;
        } else {
          tok = await redis(['HGET', K, seatKey]);
        }
        exp = expiresAt(t0);
        bustKey('share', ev);
      }
      res.status(200).json({ ok: true, token: tok, exp: exp });
      return;
    }

    if (body.action === 'revoke') {
      const tok = await redis(['HGET', K, seatKey]);
      if (tok) { await redis(['HDEL', K, tok]); await redis(['HDEL', K, seatKey]); bustKey('share', ev); }
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: 'bad_action' });
  } catch (e) {
    const msg = String(e && e.message || e);
    res.status(500).json({ error: msg === 'REDIS_ENV_MISSING' ? 'redis_env_missing' : 'server_error' });
  }
};
