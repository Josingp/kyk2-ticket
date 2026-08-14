/* ============================================================
   ticket-crypto.js — 공용 암호화 모듈 (index / verify / admin 공용)

   원리
   - 조회키: PBKDF2(이름+연락처뒤4자리, salt) → 384bit
       앞 128bit  = 레코드 ID (db.json 의 key)
       뒤 256bit  = AES-GCM 복호화 키
   - db.json 에는 이름/연락처/좌석이 평문으로 존재하지 않으며,
     올바른 이름+뒷4자리를 아는 사람만 자기 티켓을 복호화할 수 있음.
   - 확인코드: 발급 시 무작위 생성되어 암호문 안에만 존재 →
     명단에 없는 사람은 유효한 코드를 만들어낼 수 없음(위조 방지).
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TCrypto = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var subtle, getRandom;
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    subtle = crypto.subtle;
    getRandom = function (a) { return crypto.getRandomValues(a); };
  } else {
    var nodeCrypto = require('node:crypto').webcrypto;
    subtle = nodeCrypto.subtle;
    getRandom = function (a) { return nodeCrypto.getRandomValues(a); };
  }

  var te = new TextEncoder();
  var td = new TextDecoder();

  /* ---------- 정규화 ---------- */
  function normName(s) { return String(s == null ? '' : s).replace(/\s+/g, ''); }
  function last4(s) {
    var d = String(s == null ? '' : s).replace(/\D/g, '');
    return d.slice(-4);
  }
  function normCode(s) { return String(s == null ? '' : s).replace(/[^0-9a-zA-Z]/g, '').toUpperCase(); }

  /* ---------- hex ---------- */
  function toHex(buf) {
    var u = new Uint8Array(buf), s = '';
    for (var i = 0; i < u.length; i++) s += u[i].toString(16).padStart(2, '0');
    return s;
  }
  function fromHex(hex) {
    var m = hex.match(/.{2}/g) || [];
    var u = new Uint8Array(m.length);
    for (var i = 0; i < m.length; i++) u[i] = parseInt(m[i], 16);
    return u;
  }

  /* ---------- 키 유도 ---------- */
  async function derive(secret, salt, iterations) {
    var km = await subtle.importKey('raw', te.encode(secret), 'PBKDF2', false, ['deriveBits']);
    var bits = await subtle.deriveBits(
      { name: 'PBKDF2', salt: te.encode(salt), iterations: iterations, hash: 'SHA-256' },
      km, 384
    );
    var u = new Uint8Array(bits);
    var id = toHex(u.slice(0, 16));
    var key = await subtle.importKey('raw', u.slice(16, 48), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    return { id: id, key: key };
  }

  // 관람객 조회용 (이름 + 연락처 뒤 4자리)
  function deriveRecord(name, phone, cfg) {
    return derive(normName(name) + '|' + last4(phone), cfg.salt + ':record', cfg.iterations);
  }
  // 스태프 검증용 (확인코드)
  function deriveVerify(code, cfg) {
    return derive(normCode(code), cfg.salt + ':verify', cfg.iterations);
  }

  /* ---------- AES-GCM ---------- */
  async function encryptJSON(key, obj) {
    var iv = getRandom(new Uint8Array(12));
    var ct = await subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, te.encode(JSON.stringify(obj)));
    return { iv: toHex(iv), ct: toHex(ct) };
  }
  async function decryptJSON(key, box) {
    var pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromHex(box.iv) }, key, fromHex(box.ct));
    return JSON.parse(td.decode(pt));
  }

  /* ---------- 확인코드 ---------- */
  // 혼동 문자(0/O, 1/I/L) 제외 8자리
  function makeCode(len) {
    len = len || 8;
    var alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    var a = getRandom(new Uint8Array(len));
    var s = '';
    for (var i = 0; i < len; i++) s += alphabet[a[i] % alphabet.length];
    return s;
  }
  function fmtCode(c) { return normCode(c).replace(/(.{4})(?=.)/g, '$1-'); }

  return {
    normName: normName, last4: last4, normCode: normCode,
    toHex: toHex, fromHex: fromHex,
    deriveRecord: deriveRecord, deriveVerify: deriveVerify,
    encryptJSON: encryptJSON, decryptJSON: decryptJSON,
    makeCode: makeCode, fmtCode: fmtCode,
  };
});
