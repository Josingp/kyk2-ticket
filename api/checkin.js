'use strict';
/* ============================================================
   POST /api/checkin — 좌석 단위 입장 체크인
   저장: Redis HASH  tickets:<event>:checkin   field = "<확인코드>|<구역>|<좌석>", value = 입장시각(ISO)
         Redis HASH  tickets:<event>:auto      같은 field — 위치 기반 '자동 입장'으로 기록된 좌석 표식 (값 = 기록 시각)
         Redis HASH  tickets:<event>:presence  같은 field — 현장 체류 집계 {f 최초, l 최종, n 보고 횟수} (좌표 없음)

   action
   - status    : 관람객 화면용. { event, code, geo?:{d,acc}, seats?:[{z,s}] } — 비밀번호 불필요
                 (유효한 확인코드 소지 = 본인 증명). 본인 좌석 상태만 반환.
                 geo 가 있으면(행사장 반경 안) 표시 중인 미입장 좌석의 체류를 집계하고,
                 규칙(보고 횟수·체류 시간)을 만족하면 그 좌석을 자동 입장으로 기록한다.
   - set on    : 입장 처리. { event, code, z, s, on:true } — 비밀번호 불필요(본인에게 불리한 방향).
                 자동 입장 상태인 좌석을 다시 처리하면 '스태프 확인'으로 승격(confirmed).
   - list      : 관리자 현황판. { event, pw|tk } — 전체 체크인 맵 + 자동 입장 맵.
   - set off   : 입장 취소. { event, pw|tk, code, z, s, on:false } — 스태프/관리자.
   - autosweep : 위치 기반 미검표 보정(관리자). { event, pw|tk } → 미입장 + 체류 기록 좌석 목록
                 { event, pw|tk, apply:true, fields:[…] } → 선택 좌석을 자동 입장으로 기록
   ============================================================ */
const { redis, sanitizeEvent, checkPw, pwBlocked, notePwFail, checkSession, getRosterCached, getHashCached, bustKey, memLimit, readBody, audit } = require('./_lib');
const CFG = require('../assets/config.js');

const norm = v => String(v == null ? '' : v).trim();
const normCode = v => norm(v).replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
const last4 = p => { const d = String(p || '').replace(/\D/g, ''); return d.slice(-4); };

/* 자동 입장 규칙 (config.js autoCheckin) — 시각은 epoch ms 로 미리 변환 */
const AC0 = CFG.autoCheckin || {};
const AC = {
  enabled: !!AC0.enabled,
  radiusM: +AC0.radiusM || 300,
  maxAccM: +AC0.maxAccM || 200,
  minReports: +AC0.minReports || 3,
  minMs: (+AC0.minMinutes || 1) * 60000,
  from: Date.parse(AC0.collectFrom || '') || 0,
  applyFrom: Date.parse(AC0.applyFrom || AC0.collectFrom || '') || 0,
  until: Date.parse(AC0.until || '') || Infinity,
};
const GAP_MS = 30 * 60000;   /* 이 간격을 넘겨 다시 보고되면 이전 체류와 이어 세지 않는다 (체류 시간 과대 집계 방지) */

function parseP(raw) {
  if (!raw) return null;
  try { const o = JSON.parse(raw); return (o && o.f && o.l) ? o : null; } catch (e) { return null; }
}

/* 공유(선물)로 넘긴 좌석 — 소유자 기기의 체류로 자동 처리하지 않는다 (수신자 기기가 자기 좌석을 보고한다) */
function giftedSeats(shareMap, code) {
  const out = new Set();
  const endMs = Date.parse((CFG.schedule || {}).end || '') || 0;
  for (const k of Object.keys(shareMap)) {
    if (k.indexOf('s|' + code + '|') !== 0 && k.indexOf('m|' + code + '|') !== 0) continue;
    const tok = shareMap[k];
    let d = null;
    try { d = JSON.parse(shareMap[tok] || 'null'); } catch (e) {}
    if (!d || !d.t) continue;
    if (Date.now() > Math.max(d.t + 6 * 3600000, endMs)) continue;   /* share.js 의 만료 규칙과 동일 */
    const seats = Array.isArray(d.seats) ? d.seats : [{ z: d.z, s: d.s }];
    seats.forEach(w => out.add(norm(w.z) + '|' + norm(w.s)));
  }
  return out;
}

/* 체류 보고 집계 + 규칙 충족 시 자동 입장. 반환: { n, mins, autoed:[field…] } 또는 null(무시) */
async function recordPresence(ev, person, body, checkMap, req, isShared) {
  const g = body.geo || {};
  const d = Number(g.d), acc = Number(g.acc);
  if (!(d >= 0 && d <= AC.radiusM)) return null;
  if (!(acc >= 0) || acc > AC.maxAccM) return null;
  const now = Date.now();
  if (now < AC.from || now > AC.until) return null;

  /* 이 기기에 표시 중인 좌석 ∩ 명단 좌석, 이미 입장된 좌석 제외 */
  let want = Array.isArray(body.seats) ? body.seats.map(w => norm(w && w.z) + '|' + norm(w && w.s)) : null;
  const mine = (person.t || []).map(tk => norm(tk.z) + '|' + norm(tk.s));
  let held = mine.filter(zs => !want || want.indexOf(zs) !== -1);
  if (!isShared) {
    try {
      const shareMap = await getHashCached('share', ev, 10000);
      const gifted = giftedSeats(shareMap, person.c);
      if (gifted.size) held = held.filter(zs => !gifted.has(zs));
    } catch (e) {}
  }
  const fields = held.map(zs => person.c + '|' + zs).filter(f => !checkMap[f]);
  if (!fields.length) return null;

  const P = 'tickets:' + ev + ':presence';
  const prev = await redis(['HMGET', P].concat(fields)) || [];
  const setArgs = [], stats = [];
  fields.forEach((f, i) => {
    let o = parseP(prev[i]);
    if (!o) o = { f: now, l: now, n: 1 };
    else {
      if (now - o.l > GAP_MS) { o.f = now; }   /* 오래 끊겼다 돌아오면 새 체류로 */
      o.l = now; o.n = (o.n || 0) + 1;
    }
    stats.push(o);
    setArgs.push(f, JSON.stringify(o));
  });
  await redis(['HSET', P].concat(setArgs));

  /* 규칙 충족 → 자동 입장 (선착순 HSETNX: 그 사이 스태프가 처리했으면 덮어쓰지 않음) */
  const autoed = [];
  if (now >= AC.applyFrom) {
    const K = 'tickets:' + ev + ':checkin', A = 'tickets:' + ev + ':auto';
    for (let i = 0; i < fields.length; i++) {
      const o = stats[i];
      if (o.n < AC.minReports || (o.l - o.f) < AC.minMs) continue;
      const ts = new Date(now).toISOString();
      const wrote = await redis(['HSETNX', K, fields[i], ts]);
      if (wrote === 1 || wrote === '1') { await redis(['HSET', A, fields[i], ts]); autoed.push(fields[i]); }
    }
    if (autoed.length) {
      bustKey('checkin', ev); bustKey('auto', ev);
      audit(ev, 'auto', req, { n: autoed.length, z: autoed.length === 1 ? autoed[0].split('|')[1] : undefined, s: autoed.length === 1 ? autoed[0].split('|')[2] : undefined });
    }
  }
  const o0 = stats[0];
  return { n: o0.n, mins: Math.round((o0.l - o0.f) / 6000) / 10, autoed };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const body = readBody(req);
  const ev = sanitizeEvent(body.event);
  if (!ev) { res.status(400).json({ error: 'bad_event' }); return; }
  const K = 'tickets:' + ev + ':checkin';
  const A = 'tickets:' + ev + ':auto';

  try {
    /* ---- 관람객: 본인 좌석 상태 (+ 위치 체류 보고) ---- */
    if (body.action === 'status') {
      /* 행사장 LTE 는 통신사 NAT 로 수백 명이 같은 IP — IP 는 광역 상한만, 실제 한도는 확인코드(사람) 단위 */
      if (!memLimit(req, 6000)) { res.status(429).json({ error: 'too_many' }); return; }
      const code = normCode(body.code);
      if (code.length < 8) { res.status(400).json({ error: 'bad_code' }); return; }
      if (!memLimit(req, 240, 'st:' + code)) { res.status(429).json({ error: 'too_many' }); return; }
      const roster = await getRosterCached(ev, 10000);
      if (!roster || !roster.people) { res.status(404).json({ error: 'no_roster' }); return; }
      const person = roster.people.find(p => normCode(p.c) === code);
      if (!person) { res.status(404).json({ error: 'unknown_code' }); return; }
      let map = await getHashCached('checkin', ev, 3000);
      let presence = null;
      if (AC.enabled && body.geo && typeof body.geo === 'object') {
        /* 체류 보고는 별도 한도 — 보고 1회당 Redis 2~4회 호출이므로 코드당 10분 60회(약 10초 간격) 로 제한 */
        if (memLimit(req, 60, 'geo:' + code)) {
          try { presence = await recordPresence(ev, person, body, map, req, !!body.shared); } catch (e) { presence = null; }
          if (presence && presence.autoed.length) map = await getHashCached('checkin', ev, 3000);
        }
      }
      const autoMap = await getHashCached('auto', ev, 3000);
      const seats = (person.t || []).map(tk => {
        const f = person.c + '|' + norm(tk.z) + '|' + norm(tk.s);
        return { z: norm(tk.z), s: norm(tk.s), ts: map[f] || null, auto: !!(map[f] && autoMap[f]) };
      });
      const out = { ok: true, seats, now: Date.now() };
      if (presence) out.presence = { n: presence.n, mins: presence.mins };
      res.status(200).json(out);
      return;
    }

    /* ---- 입장 처리(on) — 비밀번호 불필요.
       유효한 확인코드 소지 = 본인 티켓 증명이며, 처리는 본인에게 불리한
       방향(사용 처리)이라 위조 유인이 없음. 취소는 아래에서 비밀번호 필요. ---- */
    if (body.action === 'set' && body.on) {
      if (!memLimit(req, 6000)) { res.status(429).json({ error: 'too_many' }); return; }
      const code = normCode(body.code), z = norm(body.z), s = norm(body.s);
      if (code.length < 8 || !z || !s) { res.status(400).json({ error: 'bad_seat' }); return; }
      if (!memLimit(req, 120, 'ck:' + code)) { res.status(429).json({ error: 'too_many' }); return; }
      const roster = await getRosterCached(ev, 10000);
      if (!roster || !roster.people) { res.status(404).json({ error: 'no_roster' }); return; }
      const person = roster.people.find(p => normCode(p.c) === code);
      const valid = person && (person.t || []).some(tk => norm(tk.z) === z && norm(tk.s) === s);
      if (!valid) { res.status(404).json({ error: 'unknown_seat' }); return; }
      /* 원자적 선착순: 이미 입장된 좌석이면 덮어쓰지 않고 already 로 알린다.
         (여러 게이트가 폴링 지연 사이에 같은 좌석을 동시에 처리해도 중복 입장이 드러남)
         단, 위치 기반 '자동 입장' 상태였다면 스태프 확인으로 승격한다 (시각 갱신 · auto 표식 제거). */
      const field = person.c + '|' + z + '|' + s;
      const ts = new Date().toISOString();
      const wrote = await redis(['HSETNX', K, field, ts]);
      if (wrote === 1 || wrote === '1') {
        bustKey('checkin', ev);
        res.status(200).json({ ok: true, ts, already: false });
      } else {
        const wasAuto = await redis(['HDEL', A, field]);
        if (wasAuto === 1 || wasAuto === '1') {
          await redis(['HSET', K, field, ts]);
          bustKey('checkin', ev); bustKey('auto', ev);
          res.status(200).json({ ok: true, ts, already: false, confirmed: true });
        } else {
          const cur = await redis(['HGET', K, field]);
          res.status(200).json({ ok: true, ts: cur || ts, already: true });
        }
      }
      return;
    }

    /* ---- 이하 스태프/관리자 (세션 토큰[관리자·스태프] 또는 비밀번호) ---- */
    let role = checkSession(body.tk);
    if (!role) {
      if (await pwBlocked(req)) { res.status(429).json({ error: 'too_many_attempts' }); return; }
      if (!checkPw(body.pw)) { await notePwFail(req); res.status(401).json({ error: 'unauthorized' }); return; }
      role = 'a';
    }

    if (body.action === 'list') {
      const checkins = await getHashCached('checkin', ev, 2000);
      const auto = await getHashCached('auto', ev, 2000);
      res.status(200).json({ ok: true, checkins, auto, now: Date.now() });   /* 기존 자동 입장 기록은 그대로 유지 */
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
      const field = person.c + '|' + z + '|' + s;
      await redis(['HDEL', K, field]);
      await redis(['HDEL', A, field]);
      bustKey('checkin', ev); bustKey('auto', ev);
      audit(ev, 'cancel', req, { z: z, s: s });
      res.status(200).json({ ok: true, ts: null });
      return;
    }

    /* ---- 위치 기반 미검표 보정 — 관리자만 ---- */
    if (body.action === 'autosweep') {
      if (role !== 'a') { res.status(403).json({ error: 'forbidden' }); return; }
      if (!AC.enabled) { res.status(200).json({ ok: false, error: 'auto_disabled' }); return; }
      const roster = await getRosterCached(ev, 5000);
      if (!roster || !roster.people) { res.status(404).json({ error: 'no_roster' }); return; }
      const checkMap = await getHashCached('checkin', ev, 1000);
      const pres = await getHashCached('presence', ev, 1000);
      bustKey('presence', ev);
      /* 명단 기준으로 유효한 필드만 (명단 수정으로 사라진 좌석 제외) */
      const byField = {};
      roster.people.forEach(p => (p.t || []).forEach(tk => {
        byField[p.c + '|' + norm(tk.z) + '|' + norm(tk.s)] = { p, tk };
      }));

      if (body.apply) {
        const fields = Array.isArray(body.fields) ? body.fields.map(f => String(f || '')).slice(0, 2000) : [];
        let applied = 0, skipped = 0;
        const ts = new Date().toISOString();
        for (const f of fields) {
          if (!byField[f] || !parseP(pres[f])) continue;
          const wrote = await redis(['HSETNX', K, f, ts]);
          if (wrote === 1 || wrote === '1') { await redis(['HSET', A, f, ts]); applied++; }
          else skipped++;
        }
        bustKey('checkin', ev); bustKey('auto', ev);
        audit(ev, 'autosweep', req, { n: applied });
        res.status(200).json({ ok: true, applied, skipped });
        return;
      }

      const rows = [];
      Object.keys(pres).forEach(f => {
        if (checkMap[f] || !byField[f]) return;
        const o = parseP(pres[f]); if (!o) return;
        const { p, tk } = byField[f];
        rows.push({ f, name: p.n, p4: last4(p.p), z: norm(tk.z), s: norm(tk.s), b: tk.b || '',
          n: o.n || 1, mins: Math.round((o.l - o.f) / 6000) / 10, first: o.f, last: o.l });
      });
      rows.sort((a, b) => (b.mins - a.mins) || (b.n - a.n) || String(a.name).localeCompare(String(b.name), 'ko'));
      res.status(200).json({ ok: true, rows, now: Date.now() });
      return;
    }

    res.status(400).json({ error: 'bad_action' });
  } catch (e) {
    const msg = String(e && e.message || e);
    res.status(500).json({ error: msg === 'REDIS_ENV_MISSING' ? 'redis_env_missing' : 'server_error' });
  }
};
