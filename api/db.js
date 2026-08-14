'use strict';
/* GET /api/db?event=<salt> — 암호화된 티켓 DB 반환 (공개, 어차피 암호문) */
const { sanitizeEvent, getDbCached } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }
  const ev = sanitizeEvent(req.query && req.query.event);
  if (!ev) { res.status(400).json({ error: 'bad_event' }); return; }
  try {
    const val = await getDbCached(ev, 5000);
    if (!val) {
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=5');
      res.status(404).json({ error: 'empty' });
      return;
    }
    /* Vercel 엣지 CDN 캐시: 동시 접속이 몰려도 오리진(함수+Redis)에는 15초에 1번만 도달 */
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=15, stale-while-revalidate=60');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(val);
  } catch (e) {
    const msg = String(e && e.message || e);
    res.status(500).json({ error: msg === 'REDIS_ENV_MISSING' ? 'redis_env_missing' : 'server_error' });
  }
};
