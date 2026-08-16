/* ============================================================
   e2e.js — 티켓 앱 종단 테스트 (실서비스 코드 그대로 실행)
   사용법:  npm i jsdom  →  node e2e.js [리포 경로 · 생략 시 현재 폴더]
   검증 범위: 조회 폼 → 암호화 레코드 복호화 → 티켓 렌더 → 좌석 안내
   (미니맵·상세 방향·출입구 경로·다중 좌석 표기·명단 오기 경고·
    조회 실패 메시지·0매 인원·중복 좌석 차단 팝업 — 파싱 순서 프리플라이트 + 총 8개 시나리오 46개 체크)
   ※ 회차 변경(장충 8/27 등) 후 배포 전에 한 번 돌려보세요.
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : __dirname;   // 사용법: node e2e.js [리포경로]
const TC = require(path.join(ROOT, 'assets/ticket-crypto.js'));
const CFG = require(path.join(ROOT, 'assets/config.js'));


const vc = new VirtualConsole(); vc.on('jsdomError', () => {}); // 외부 CDN 폰트 실패 등 무시

async function makeBox(person, name, phone) {
  const d = await TC.deriveRecord(name, phone, CFG);
  const box = await TC.encryptJSON(d.key, person);
  return { id: d.id, box };
}

/* 파싱 순서 프리플라이트 — 각 인라인 스크립트를 '그 시점까지 파싱된 DOM'에서 실행.
   실제 브라우저는 스크립트를 만나는 즉시 실행하므로, 스크립트가 자기보다 아래에 있는
   요소를 최상위에서 참조하면 크래시한다(jsdom 전체 파싱 후 실행이라 기본 케이스가 못 잡음). */
async function parseOrderPreflight(){
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const re = /<script(?:\s+src="([^"]+)")?[^>]*>([\s\S]*?)<\/script>/g;
  const scripts = []; let m;
  while ((m = re.exec(html))) scripts.push({ src: m[1] || null, code: m[2], pos: m.index });
  const inln = scripts.filter(s => !s.src).length;
  let bad = 0;
  for (let k = 0; k < scripts.length; k++){
    if (scripts[k].src) continue;
    const partial = html.slice(0, scripts[k].pos) + '</body></html>';
    const dom = new JSDOM(partial, { url: 'file://' + ROOT + '/index.html',
      runScripts: 'outside-only', virtualConsole: vc, pretendToBeVisual: true });
    const w = dom.window;
    if (!w.crypto || !w.crypto.subtle) Object.defineProperty(w, 'crypto', { value: require('node:crypto').webcrypto });
    w.scrollTo = () => {}; w.alert = () => {}; w.confirm = () => true;
    w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener(){}, removeListener(){} }));
    w.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
    let threw = null;
    try {
      for (let j = 0; j <= k; j++){
        const code = scripts[j].src
          ? fs.readFileSync(path.join(ROOT, scripts[j].src), 'utf8')
          : scripts[j].code;
        w.eval(code);
      }
    } catch (e) { threw = e; }
    dom.window.close();
    if (threw){ console.log('❌ 스크립트 #' + (k + 1) + ' — 파싱 시점 실행 오류: ' + threw.message); bad++; }
  }
  console.log((bad ? '❌' : '✅') + ' 파싱 순서 프리플라이트 (인라인 ' + inln + '개, 브라우저 실행 시점 재현)');
  return bad;
}

async function runCase(label, name, phone, person, checks, opts) {
  opts = opts || {};
  const rec = await makeBox(person, opts.boxName || name, opts.boxPhone || phone);
  const ck = {};   // 체크인 목 저장소 (HSETNX 의미론)
  if (opts.preCheckedTs && person.t && person.t[0])
    ck[String(person.t[0].z).trim() + '|' + String(person.t[0].s).trim()] = opts.preCheckedTs;
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'file://' + ROOT + '/index.html',
    runScripts: 'dangerously',
    resources: 'usable',
    virtualConsole: vc,
    pretendToBeVisual: true,
  });
  const w = dom.window;
  // 브라우저 API 보강
  if (!w.crypto || !w.crypto.subtle) Object.defineProperty(w, 'crypto', { value: require('node:crypto').webcrypto });
  w.scrollTo = () => {};
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener(){}, removeListener(){} }));
  // fetch 목: /api/box → 암호화 레코드, 나머지 API → 무해 응답
  w.fetch = async (url, opt) => {
    const u = String(url);
    if (u.includes('/api/box') || (opt && opt.body && String(opt.body).includes('"id"'))) {
      let reqId = null;
      try { reqId = JSON.parse(opt.body).id; } catch (e) {}
      if (reqId === rec.id) return { ok: true, status: 200, json: async () => ({ box: rec.box }) };
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (u.includes('/api/checkin')) {
      let b = {}; try { b = JSON.parse(opt.body); } catch (e) {}
      if (b.action === 'set' && b.on) {
        const key = b.z + '|' + b.s;
        if (ck[key]) return { ok: true, status: 200, json: async () => ({ ok: true, ts: ck[key], already: true }) };
        ck[key] = new Date().toISOString();
        return { ok: true, status: 200, json: async () => ({ ok: true, ts: ck[key], already: false }) };
      }
      if (b.action === 'status') {
        const seats = (person.t || []).map(tk => ({ z: String(tk.z).trim(), s: String(tk.s).trim(), ts: ck[String(tk.z).trim() + '|' + String(tk.s).trim()] || null }));
        return { ok: true, status: 200, json: async () => ({ ok: true, seats, now: Date.now() }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };

  await new Promise(res => { w.addEventListener('load', res); setTimeout(res, 4000); });

  // 조회 폼 입력 + 제출 (사용자 행동 그대로)
  w.document.querySelector('#inName').value = name;
  w.document.querySelector('#inPhone').value = phone;
  w.document.querySelector('#form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));

  // 렌더 완료 대기 (#seatGuide 표시될 때까지 폴링)
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 100));
    const g = w.document.querySelector('#seatGuide');
    if (g && g.style.display === 'block') break;
    const msg = w.document.querySelector('#msg');
    if (msg && msg.classList.contains('show')) break;
  }

  /* 입장 버튼 클릭 시뮬레이션 (게이트 스태프 동작) */
  if (opts.clickCheckin) {
    w.confirm = () => true;
    const cb = w.document.querySelector('#tickets .t-staffbtn');
    if (cb) { cb.click(); await new Promise(r => setTimeout(r, 500)); }
    if (opts.clickDupConfirm) {
      const db = w.document.querySelector('#dupBtn');
      if (db) { db.click(); await new Promise(r => setTimeout(r, 200)); }
    }
  }

  const doc = w.document;
  const guide = doc.querySelector('#seatGuide');
  const tickets = doc.querySelector('#tickets');
  const ctx = {
    guideHTML: guide ? guide.innerHTML : '',
    guideShown: guide && guide.style.display === 'block',
    ticketCount: tickets ? tickets.querySelectorAll('article.ticket').length : 0,
    msg: (doc.querySelector('#msg') || {}).textContent || '',
    doc, w,
  };
  console.log('\n===== ' + label + ' =====');
  let pass = 0, fail = 0;
  for (const [desc, fn] of checks) {
    let ok = false, err = '';
    try { ok = !!fn(ctx); } catch (e) { err = e.message; }
    console.log((ok ? '✅' : '❌') + ' ' + desc + (err ? ' — ' + err : ''));
    ok ? pass++ : fail++;
  }
  dom.window.close();
  return fail;
}

(async () => {
  let fails = 0;

  fails += await parseOrderPreflight();

  // 케이스 1: 정상 단일 티켓 (203구역 2열 3번 — 양식 예시 좌석)
  fails += await runCase('정상 단일 · 203구역 2열 3번', '테스트일', '010-0000-1111',
    { n: '테스트일', c: 'TESTCODE1', t: [{ z: '203구역', s: '2열 3번' }] }, [
    ['티켓 1매 렌더', c => c.ticketCount === 1],
    ['좌석 안내 표시됨', c => c.guideShown],
    ['미니맵 SVG 존재', c => c.guideHTML.includes('<svg')],
    ['203구역 하이라이트', c => c.guideHTML.includes('data-zone="203"') && c.guideHTML.includes('class="sg-zone hl"')],
    ['경로: 2번 출입구(202·203 구역 사이)', c => c.guideHTML.includes('2번 출입구</b>(202·203 구역 사이)로 진입')],
    ['내 좌석 점(sg-dot-mine)', c => c.guideHTML.includes('sg-dot-mine')],
    ['상세: 10열이 1열보다 위(도면 방향)', c => c.guideHTML.indexOf('>10열<') < c.guideHTML.indexOf('>1열<')],
    ['상세: 코트 ▼ 아래', c => c.guideHTML.indexOf('sg-gridwrap') < c.guideHTML.indexOf('▼ 무대 · 코트 방향 ▼')],
    ['mine 셀에 좌석번호 3', c => /class="sg-seat mine">3</.test(c.guideHTML)],
    ['오기 경고 없음', c => !c.guideHTML.includes('sg-warn')],
    ['가~라 배지 없음', c => !c.guideHTML.includes('>가<') && !c.guideHTML.includes('sg-gate')],
    ['번호 게이트 1~10 표시', c => c.guideHTML.includes('>1<') && c.guideHTML.includes('>10<')],
  ]);

  // 케이스 2: 아래쪽 구역 + 다중 표기 (215구역 3열 5·6번)
  fails += await runCase('아래쪽 구역 · 215구역 3열 5·6번(가운뎃점)', '테스트이', '010-0000-2222',
    { n: '테스트이', c: 'TESTCODE2', t: [{ z: '2층 215구역', s: '3열 5·6번' }] }, [
    ['좌석 안내 표시됨', c => c.guideShown],
    ['215 하이라이트', c => c.guideHTML.includes('data-zone="215"') && c.guideHTML.includes('sg-zone hl')],
    ['경로: 9번 출입구(215·216 구역 사이)', c => c.guideHTML.includes('9번 출입구</b>(215·216 구역 사이)')],
    ['FU: 1열이 10열보다 위', c => c.guideHTML.indexOf('>1열<') < c.guideHTML.indexOf('>10열<')],
    ['FU: 코트 ▲ 위', c => c.guideHTML.indexOf('▲ 무대 · 코트 방향 ▲') < c.guideHTML.indexOf('sg-gridwrap')],
    ['mine 2석(5·6번) 모두 표시', c => (c.guideHTML.match(/sg-seat mine/g) || []).length === 2],
    ['방향 문구: 왼쪽 10번 → 오른쪽 1번', c => /왼쪽 <b>10번<\/b> → 오른쪽 <b>1번<\/b>/.test(c.guideHTML)],
  ]);

  // 케이스 3: 명단 오기 (202구역 1열 15번 — 실제로는 10번까지)
  fails += await runCase('명단 오기 · 202구역 1열 15번', '테스트삼', '010-0000-3333',
    { n: '테스트삼', c: 'TESTCODE3', t: [{ z: '202구역', s: '1열 15번' }] }, [
    ['좌석 안내 표시됨', c => c.guideShown],
    ['오기 경고 표시', c => c.guideHTML.includes('sg-warn') && c.guideHTML.includes('찾지 못했습니다')],
    ['구역은 하이라이트 유지', c => c.guideHTML.includes('sg-zone hl')],
  ]);

  // 케이스 4: 일행 3매 · 두 구역 (대표 조회)
  fails += await runCase('일행 3매 · 202+204', '테스트사', '010-0000-4444',
    { n: '테스트사', c: 'TESTCODE4', t: [
      { z: '202구역', s: '5열 6번' }, { z: '202구역', s: '5열 7번' }, { z: '204구역', s: '2열 3번', b: '동반인' },
    ] }, [
    ['티켓 3매 렌더', c => c.ticketCount === 3],
    ['두 구역 모두 상세 생성', c => (c.guideHTML.match(/sg-detail/g) || []).length === 2],
    ['202 mine 2석', c => { const d = c.guideHTML.split('sg-detail'); return (d[1].match(/sg-seat mine/g) || []).length === 2; }],
    ['204 경로: 3번 출입구(204·205 구역 사이)', c => c.guideHTML.includes('3번 출입구</b>(204·205 구역 사이)')],
    ['204 해피존 메모 표시', c => c.guideHTML.includes('해피존')],
  ]);

  // 케이스 5: 명단에 없는 사람 — DB에 없는 ID 조회 (박스는 '아무개' 명의로만 존재)
  fails += await runCase('명단에 없는 사람', '없는사람', '010-9999-9999',
    { n: '아무개', c: 'X', t: [{ z: '203구역', s: '2열 3번' }] }, [
    ['안내 메시지 표시', c => c.msg.includes('일치하는 티켓이 없습니다')],
    ['좌석 안내 숨김', c => !c.guideShown],
    ['티켓 미렌더', c => c.ticketCount === 0],
  ], { boxName: '아무개', boxPhone: '010-8888-8888' });

  // 케이스 6: 명단엔 있으나 티켓 0매 (좌석 전부 회수된 인원) — 크래시 없이 처리되는지
  fails += await runCase('티켓 0매 인원', '테스트영', '010-0000-0000',
    { n: '테스트영', c: 'TESTCODE0', t: [] }, [
    ['크래시 없음(인사말 렌더)', c => (c.doc.querySelector('#hello') || {}).textContent.includes('0매')],
    ['좌석 안내 숨김', c => !c.guideShown],
    ['티켓 0매', c => c.ticketCount === 0],
  ]);

  // 케이스 7: 중복 좌석 — 다른 화면에서 이미 입장된 좌석에 입장 시도 → 차단 팝업(확인 눌러도 유지)
  fails += await runCase('중복 좌석 차단 팝업', '테스트칠', '010-0000-7777',
    { n: '테스트칠', c: 'TESTCODE7', t: [{ z: '203구역', s: '2열 3번' }] }, [
    ['차단 팝업 표시', c => c.doc.querySelector('#dupOverlay').classList.contains('show')],
    ['팝업에 좌석 표기', c => c.doc.querySelector('#dupSeat').textContent.includes('203구역')],
    ['팝업에 최초 입장시각(19:42 KST)', c => c.doc.querySelector('#dupTs').textContent.includes('19:42')],
    ['확인 눌러도 닫히지 않음', c => c.doc.querySelector('#dupOverlay').classList.contains('show')],
    ['확인 버튼이 차단 문구로 전환', c => c.doc.querySelector('#dupBtn').textContent.includes('닫을 수 없습니다')],
    ['티켓이 선점 상태로 표시(입장완료 아님)', c => {
      const art = c.doc.querySelector('#tickets .ticket');
      return art.classList.contains('dup') && art.querySelector('.t-state').textContent.includes('이미 선점된 좌석');
    }],
    ['도장 문구 = 입장 불가', c => c.doc.querySelector('.t-stamp span').textContent.includes('입장 불가')],
  ], { clickCheckin: true, clickDupConfirm: true, preCheckedTs: '2026-08-20T10:42:00.000Z' });

  // 케이스 8: 정상 선착 입장 → 팝업 없이 입장 완료
  fails += await runCase('정상 선착 입장', '테스트팔', '010-0000-8888',
    { n: '테스트팔', c: 'TESTCODE8', t: [{ z: '215구역', s: '3열 5번' }] }, [
    ['팝업 없음', c => !c.doc.querySelector('#dupOverlay').classList.contains('show')],
    ['입장 완료 상태', c => {
      const art = c.doc.querySelector('#tickets .ticket');
      return art.classList.contains('used') && !art.classList.contains('dup') &&
             art.querySelector('.t-state').textContent.includes('입장 완료');
    }],
    ['도장 문구 = 입장 완료', c => c.doc.querySelector('.t-stamp span').textContent.includes('입장 완료')],
  ], { clickCheckin: true });

  console.log('\n총 실패:', fails);
  process.exit(fails ? 1 : 0);
})();
