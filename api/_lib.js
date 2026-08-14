'use strict';
/* ============================================================
   api/_lib.js — 서버 함수 공용 헬퍼 (Upstash Redis REST)

   필요 환경변수 (Vercel 프로젝트 설정)
   - UPSTASH_REDIS_REST_URL  / UPSTASH_REDIS_REST_TOKEN
     (또는 Vercel Marketplace 연동 시 자동 주입되는
      KV_REST_API_URL / KV_REST_API_TOKEN 도 인식)
   - ADMIN_PASSWORD_SHA256 (선택) — 관리자 비밀번호의 SHA-256 hex.
     미설정 시 기본 비밀번호의 해시를 사용.
   ============================================================ */
const crypto = require('node:crypto');

// 기본 관리자 비밀번호 해시 (index.html 의 ADMIN_HASH 와 동일 값)
const DEFAULT_PW_HASH = '1f5e0b0c7f0baac5bf80d43beb3d259f1f22295960d0bc158e24bee738c72831';

function redisEnv() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

/* 단일 Redis 명령 실행. 예: redis(['GET','key']) */
async function redis(cmd) {
  const env = redisEnv();
  if (!env) throw new Error('REDIS_ENV_MISSING');
  const res = await fetch(env.url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error('REDIS: ' + (j.error || res.status));
  return j.result;
}

/* 회차 키(config.js 의 salt) 검증 — 영문/숫자/-/_ 만 허용 */
function sanitizeEvent(e) {
  const s = String(e || '').trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : null;
}

function checkPw(pw) {
  const h = crypto.createHash('sha256').update(String(pw || ''), 'utf8').digest('hex');
  const want = (process.env.ADMIN_PASSWORD_SHA256 || DEFAULT_PW_HASH).toLowerCase();
  const a = Buffer.from(h, 'hex'), b = Buffer.from(want, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

/* 비밀번호 무차별 대입 방지: 실패만 집계, 10분에 20회 초과 시 차단 */
async function pwBlocked(req) {
  const n = parseInt(await redis(['GET', 'tickets:fail:' + clientIp(req)]) || '0', 10);
  return n > 20;
}
async function notePwFail(req) {
  const key = 'tickets:fail:' + clientIp(req);
  const n = await redis(['INCR', key]);
  if (n === 1) await redis(['EXPIRE', key, '600']);
}

/* 인증 없는 엔드포인트 남용 방지 (여유 있는 한도 — 폴링 허용) */
async function softLimit(req, max) {
  const key = 'tickets:sl:' + clientIp(req);
  const n = await redis(['INCR', key]);
  if (n === 1) await redis(['EXPIRE', key, '600']);
  return n <= (max || 900);
}

/* ── 저장 데이터 암호화 (개인정보 안전성 확보조치) ──
   환경변수 DATA_KEY 설정 시 명단을 AES-256-GCM으로 암호화해 저장한다.
   Upstash에는 암호문만 남아, 저장소가 유출돼도 명단(이름·연락처)이 노출되지 않는다. */
function dataKey() {
  const k = process.env.DATA_KEY;
  if (!k) return null;
  return crypto.createHash('sha256').update(String(k), 'utf8').digest();
}
function encryptStr(plain) {
  const key = dataKey();
  if (!key) return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'enc1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function decryptStr(v) {
  if (typeof v !== 'string' || v.indexOf('enc1:') !== 0) return v;
  const key = dataKey();
  if (!key) return null;
  try {
    const b = Buffer.from(v.slice(5), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch (e) { return null; }
}

/* ── TOTP (RFC 6238) — Microsoft Authenticator 등 표준 인증앱 호환 ── */
function b32decode(s) {
  s = String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0; const out = [];
  for (const ch of s) {
    val = (val << 5) | A.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpAt(secretB32, tSec) {
  const key = b32decode(secretB32);
  const c = Math.floor(tSec / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(c / 4294967296), 0);
  buf.writeUInt32BE(c >>> 0, 4);
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const o = h[19] & 15;
  const n = (((h[o] & 127) << 24) | (h[o+1] << 16) | (h[o+2] << 8) | h[o+3]) % 1000000;
  return String(n).padStart(6, '0');
}
function verifyTotp(code) {
  const s = process.env.TOTP_SECRET;
  if (!s) return false;
  code = String(code || '').replace(/\D/g, '');
  if (code.length !== 6) return false;
  const now = Math.floor(Date.now() / 1000);
  for (let w = -1; w <= 1; w++) {
    const want = totpAt(s, now + w * 30);
    if (want.length === code.length &&
        crypto.timingSafeEqual(Buffer.from(want), Buffer.from(code))) return true;
  }
  return false;
}
/* OTP 강제 여부: TOTP_SECRET + DATA_KEY(세션용) 둘 다 있어야 활성화 */
function totpOn() { return !!(process.env.TOTP_SECRET && dataKey()); }

/* ── 역할 기반 세션 토큰: 'a'=관리자(명단 접근 가능) · 's'=스태프(입장 처리만) ── */
function makeSession(hours, role) {
  const key = dataKey();
  if (!key) return null;
  role = role === 's' ? 's' : 'a';
  const exp = Date.now() + (hours || 6) * 3600000;
  const mac = crypto.createHmac('sha256', key).update(role + '|' + exp).digest('hex').slice(0, 40);
  return role + '.' + exp + '.' + mac;
}
function checkSession(tok) {
  const key = dataKey();
  if (!key || typeof tok !== 'string') return null;
  const p = tok.split('.');
  if (p.length !== 3) return null;
  const role = p[0], exp = parseInt(p[1], 10);
  if ((role !== 'a' && role !== 's') || !exp || Date.now() > exp) return null;
  const want = crypto.createHmac('sha256', key).update(role + '|' + exp).digest('hex').slice(0, 40);
  const a = Buffer.from(p[2]), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return role;
}

/* 서버 저장 명단 로드 (암호문이면 복호화) */
async function getRoster(ev) {
  let v = await redis(['GET', 'tickets:' + ev + ':roster']);
  if (!v) return null;
  v = decryptStr(v);
  if (!v) return null;
  try { return JSON.parse(v); } catch (e) { return null; }
}

/* ── 인스턴스 메모리 캐시 ──
   웜 상태의 서버 함수가 요청마다 Redis를 때리지 않도록 짧은 TTL로 결과를 재사용.
   행사 당일 수백 명이 동시에 폴링해도 Redis 호출은 인스턴스당 TTL 주기로만 발생. */
const MEM = { store: new Map(), rl: new Map() };
function memGet(k) {
  const e = MEM.store.get(k);
  if (e && Date.now() < e.exp) return e.v;
  MEM.store.delete(k);
  return undefined;
}
function memSet(k, v, ttl) { MEM.store.set(k, { v, exp: Date.now() + ttl }); return v; }
function bustKey(name, ev) { MEM.store.delete(name + ':' + ev); }
function bustEvent(ev) { ['roster', 'db', 'checkin', 'share'].forEach(n => bustKey(n, ev)); }

async function getRosterCached(ev, ttl) {
  const k = 'roster:' + ev;
  let v = memGet(k);
  if (v !== undefined) return v;
  v = await getRoster(ev);
  return memSet(k, v, ttl || 10000);
}
async function getDbCached(ev, ttl) {
  const k = 'db:' + ev;
  let v = memGet(k);
  if (v !== undefined) return v;
  v = await redis(['GET', 'tickets:' + ev + ':db']);
  return memSet(k, v, ttl || 5000);
}
async function getHashCached(name, ev, ttl) {
  const k = name + ':' + ev;
  let v = memGet(k);
  if (v !== undefined) return v;
  const flat = await redis(['HGETALL', 'tickets:' + ev + ':' + name]) || [];
  const m = {};
  for (let i = 0; i < flat.length; i += 2) m[flat[i]] = flat[i + 1];
  return memSet(k, m, ttl || 3000);
}

/* 인증 없는 엔드포인트용 인메모리 요청 한도(10분 창) — Redis 소모 없음 */
function memLimit(req, max) {
  const ip = clientIp(req), now = Date.now();
  let e = MEM.rl.get(ip);
  if (!e || now > e.exp) {
    if (MEM.rl.size > 5000) MEM.rl.clear();
    e = { n: 0, exp: now + 600000 };
    MEM.rl.set(ip, e);
  }
  return ++e.n <= (max || 900);
}

function readBody(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = null; } }
  return (b && typeof b === 'object') ? b : {};
}

module.exports = { redis, sanitizeEvent, checkPw, pwBlocked, notePwFail, softLimit, getRoster, readBody,
  getRosterCached, getDbCached, getHashCached, bustKey, bustEvent, memLimit,
  encryptStr, decryptStr, dataKey, makeSession, checkSession, totpAt, verifyTotp, totpOn };
