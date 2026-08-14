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

/* IP당 10분에 30회 제한 (관리자 API 무차별 대입 방지) */
async function rateLimit(req) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const key = 'tickets:rl:' + ip;
  const n = await redis(['INCR', key]);
  if (n === 1) await redis(['EXPIRE', key, '600']);
  return n <= 30;
}

function readBody(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = null; } }
  return (b && typeof b === 'object') ? b : {};
}

module.exports = { redis, sanitizeEvent, checkPw, rateLimit, readBody };
