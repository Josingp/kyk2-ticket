'use strict';
/* GET /api/db?event=<salt> — 암호화된 티켓 DB 반환 (공개, 어차피 암호문) */
const { redis, sanitizeEvent } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const ev = sanitizeEvent(req.query && req.query.event);
  if (!ev) { res.status(400).json({ error: 'bad_event' }); return; }
  try {
    const val = await redis(['GET', 'tickets:' + ev + ':db']);
    if (!val) { res.status(404).json({ error: 'empty' }); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(val);
  } catch (e) {
    const msg = String(e && e.message || e);
    res.status(500).json({ error: msg === 'REDIS_ENV_MISSING' ? 'redis_env_missing' : 'server_error' });
  }
};
