/* ============================================================
   e2e.js — 티켓 앱 종단 테스트 (실서비스 코드 그대로 실행)
   사용법:  npm i jsdom  →  node e2e.js [리포 경로 · 생략 시 현재 폴더]
   검증 범위: 조회 폼 → 암호화 레코드 복호화 → 티켓 렌더 → 좌석 안내
   (미니맵·상세 방향·출입구 경로·다중 좌석 표기·명단 오기 경고·
    조회 실패 메시지·0매 인원·중복 좌석 차단 팝업 — 파싱 순서 프리플라이트 + 총 8개 시나리오 48개 체크)
   ※ 회차 변경 후 배포 전에 한 번 돌려보세요. (현재 시나리오: 8/27 장충체육관 도면 기준)
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

  /* 공개 녹화 관람 동의 게이트: 팝업 확인 후 조회 진행 */
  await new Promise(r => setTimeout(r, 150));
  const agrEl = w.document.querySelector('#agrOverlay');
  const agrShown = !!(agrEl && agrEl.classList.contains('show'));
  if (agrShown) w.document.querySelector('#agrBtn').click();

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
    agrShown,
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

  // 케이스 1: 정상 단일 티켓 (장충 G2구역 1열 3번)
  fails += await runCase('정상 단일 · G2구역 1열 3번', '테스트일', '010-0000-1111',
    { n: '테스트일', c: 'TESTCODE1', t: [{ z: 'G2구역', s: '1열 3번' }] }, [
    ['제출 시 관람 동의 팝업 표시', c => c.agrShown],
    ['확인하였습니다 → 팝업 닫히고 조회 진행', c => !c.doc.querySelector('#agrOverlay').classList.contains('show')],
    ['티켓 1매 렌더', c => c.ticketCount === 1],
    ['좌석 안내 표시됨', c => c.guideShown],
    ['미니맵 SVG 존재', c => c.guideHTML.includes('<svg')],
    ['G2구역 하이라이트', c => c.guideHTML.includes('data-zone="G2"') && c.guideHTML.includes('class="sg-zone hl"')],
    ['경로: GATE 4(2층 스탠드 출입구) → G2구역', c => c.guideHTML.includes('GATE 4</b>(2층 스탠드 출입구)로 진입') && c.guideHTML.includes('→ G2구역')],
    ['내 좌석 점(sg-dot-mine)', c => c.guideHTML.includes('sg-dot-mine')],
    ['상세: 10열이 1열보다 위(도면 방향)', c => c.guideHTML.indexOf('>10열<') < c.guideHTML.indexOf('>1열<')],
    ['상세: 코트 ▼ 아래', c => c.guideHTML.indexOf('sg-gridwrap') < c.guideHTML.indexOf('▼ 무대 · 코트 방향 ▼')],
    ['mine 셀에 좌석번호 3', c => /class="sg-seat mine">3</.test(c.guideHTML)],
    ['오기 경고 없음', c => !c.guideHTML.includes('sg-warn')],
    ['게이트 표찰 GATE 1~8 표시', c => c.guideHTML.includes('GATE 1</text>') && c.guideHTML.includes('GATE 8</text>')],
  ]);

  // 케이스 2: 아래쪽 구역(FU) + "2층 A구역" 표기 + 가운뎃점 다중 좌석
  fails += await runCase('아래쪽 구역 · 2층 A구역 3열 31·32번', '테스트이', '010-0000-2222',
    { n: '테스트이', c: 'TESTCODE2', t: [{ z: '2층 A구역', s: '3열 31·32번' }] }, [
    ['좌석 안내 표시됨', c => c.guideShown],
    ['A2 하이라이트', c => c.guideHTML.includes('data-zone="A2"') && c.guideHTML.includes('sg-zone hl')],
    ['경로: GATE 1(2층 스탠드 출입구) → A2구역', c => c.guideHTML.includes('GATE 1</b>(2층 스탠드 출입구)로 진입') && c.guideHTML.includes('→ A2구역')],
    ['FU: 1열이 10열보다 위', c => c.guideHTML.indexOf('>1열<') < c.guideHTML.indexOf('>10열<')],
    ['FU: 코트 ▲ 위', c => c.guideHTML.indexOf('▲ 무대 · 코트 방향 ▲') < c.guideHTML.indexOf('sg-gridwrap')],
    ['mine 2석(31·32번) 모두 표시', c => (c.guideHTML.match(/sg-seat mine/g) || []).length === 2],
    ['방향 문구: 왼쪽 46번 → 오른쪽 31번', c => /왼쪽 <b>46번<\/b> → 오른쪽 <b>31번<\/b>/.test(c.guideHTML)],
  ]);

  // 케이스 3: 명단 오기 (G2구역 1열 200번 — 실제 최대 187번)
  fails += await runCase('명단 오기 · G2구역 1열 200번', '테스트삼', '010-0000-3333',
    { n: '테스트삼', c: 'TESTCODE3', t: [{ z: 'G2구역', s: '1열 200번' }] }, [
    ['좌석 안내 표시됨', c => c.guideShown],
    ['오기 경고 표시', c => c.guideHTML.includes('sg-warn') && c.guideHTML.includes('찾지 못했습니다')],
    ['구역은 하이라이트 유지', c => c.guideHTML.includes('sg-zone hl')],
  ]);

  // 케이스 4: 일행 3매 · 두 구역 (대표 조회) + 등급명 표기
  fails += await runCase('일행 3매 · G2+H2', '테스트사', '010-0000-4444',
    { n: '테스트사', c: 'TESTCODE4', t: [
      { z: 'G2구역', s: '5열 98번' }, { z: 'G2구역', s: '5열 99번' }, { z: 'H2구역', s: '2열 16번', b: '동반인' },
    ] }, [
    ['티켓 3매 렌더', c => c.ticketCount === 3],
    ['두 구역 모두 상세 생성', c => (c.guideHTML.match(/sg-detail/g) || []).length === 2],
    ['G2 mine 2석', c => { const d = c.guideHTML.split('sg-detail'); return (d[1].match(/sg-seat mine/g) || []).length === 2; }],
    ['H2 경로: GATE 4 → H2구역', c => c.guideHTML.includes('→ H2구역')],
    ['등급명(2층석) 표기', c => c.guideHTML.includes('2층석')],
  ]);

  // 케이스 4b: 이번 수정 회귀 — R1 17번(엑셀 오기 정정) + "번" 없는 좌석 표기
  fails += await runCase('수정 회귀 · R1 16번 + 번 없는 표기(B2 98)', '테스트오', '010-0000-5555',
    { n: '테스트오', c: 'TESTCODE5', t: [
      { z: 'R1구역', s: '16번' }, { z: 'B2구역', s: '98' },
    ] }, [
    ['두 구역 모두 상세 생성', c => (c.guideHTML.match(/sg-detail/g) || []).length === 2],
    ['R1 16번 좌석 표시', c => /class="sg-seat mine">16</.test(c.guideHTML)],
    ['B2 98(번 표기 없음) 좌석 표시', c => /class="sg-seat mine">98</.test(c.guideHTML)],
    ['1층 동선 문구(현장 스태프 안내)', c => c.guideHTML.includes('현장 스태프 안내에 따라 R1구역')],
    ['오기 경고 없음', c => !c.guideHTML.includes('sg-warn')],
  ]);

  // 케이스 5: 명단에 없는 사람 — DB에 없는 ID 조회 (박스는 '아무개' 명의로만 존재)
  fails += await runCase('명단에 없는 사람', '없는사람', '010-9999-9999',
    { n: '아무개', c: 'X', t: [{ z: 'G2구역', s: '1열 3번' }] }, [
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
    { n: '테스트칠', c: 'TESTCODE7', t: [{ z: 'G2구역', s: '1열 3번' }] }, [
    ['차단 팝업 표시', c => c.doc.querySelector('#dupOverlay').classList.contains('show')],
    ['팝업에 좌석 표기', c => c.doc.querySelector('#dupSeat').textContent.includes('G2구역')],
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
    { n: '테스트팔', c: 'TESTCODE8', t: [{ z: 'A2구역', s: '3열 31번' }] }, [
    ['팝업 없음', c => !c.doc.querySelector('#dupOverlay').classList.contains('show')],
    ['입장 완료 상태', c => {
      const art = c.doc.querySelector('#tickets .ticket');
      return art.classList.contains('used') && !art.classList.contains('dup') &&
             art.querySelector('.t-state').textContent.includes('입장 완료');
    }],
    ['도장 문구 = 입장 완료', c => c.doc.querySelector('.t-stamp span').textContent.includes('입장 완료')],
    ['비표 팝업 없음(일반 인원)', c => !c.doc.querySelector('#bdgOverlay').classList.contains('show')],
  ], { clickCheckin: true });

  // 케이스 9: 비표 대상자 — 동의 팝업 확인 → 티켓 표시 직후 비표 안내 팝업
  fails += await runCase('비표 대상자 안내 팝업', '테스트구', '010-0000-9999',
    { n: '테스트구', c: 'TESTCODE9', t: [{ z: 'R1구역', s: '1번' }], bd: { n: 3 } }, [
    ['동의(촬영 안내) 팝업이 먼저 떴음', c => c.agrShown],
    ['비표 팝업 표시', c => c.doc.querySelector('#bdgOverlay').classList.contains('show')],
    ['제목 = 비표대상자입니다', c => c.doc.querySelector('#bdgTitle').textContent.includes('비표대상자입니다')],
    ['안내 문구(인포데스크·VIP입구)', c => {
      const t = c.doc.querySelector('#bdgOverlay').textContent;
      return t.includes('인포데스크') && t.includes('VIP입구');
    }],
    ['대상 정보(이름·매수)', c => {
      const t = c.doc.querySelector('#bdgWho').textContent;
      return t.includes('테스트구') && t.includes('3매');
    }],
    ['확인 누르면 닫힘', c => { c.doc.querySelector('#bdgBtn').click(); return !c.doc.querySelector('#bdgOverlay').classList.contains('show'); }],
    ['티켓은 정상 렌더', c => c.ticketCount === 1],
  ]);

  // 케이스 10: 양도 제한 — 1장 보유자는 공유 불가, C1/D1/F1 좌석 공유 불가
  fails += await runCase('양도 제한(혼합 구역)', '테스트십', '010-0000-1010',
    { n: '테스트십', c: 'TESTCODE10', t: [{ z: 'D1구역', s: '1열 1번' }, { z: 'I1구역', s: '3열 5번' }, { z: 'I1구역', s: '3열 6번' }] }, [
    ['공유 버튼은 I1 두 장에만', c => c.doc.querySelectorAll('#tickets .t-sharebtn').length === 2],
    ['D1 티켓엔 공유 버튼 없음', c => {
      const arts = [...c.doc.querySelectorAll('#tickets .ticket')];
      const d1 = arts.find(a => a.textContent.includes('D1'));
      return d1 && !d1.querySelector('.t-sharebtn');
    }],
    ['묶음 보내기 = 양도 가능 2매만', c => {
      const ms = c.doc.querySelector('#multiShare');
      return ms.style.display !== 'none' && ms.querySelectorAll('.ms-list .ms-row').length === 2 &&
             ms.textContent.includes('전체 선택') && ms.textContent.includes('(2매)');
    }],
  ]);

  // 케이스 11: 1장 보유자·양도불가 구역 전용 — 공유 UI 전무
  fails += await runCase('양도 불가(1장 보유)', '테스트열하나', '010-0000-1111',
    { n: '테스트열하나', c: 'TESTCODE11', t: [{ z: 'A2구역', s: '2열 9번' }] }, [
    ['한 장뿐이면 공유 버튼 없음', c => c.doc.querySelectorAll('#tickets .t-sharebtn').length === 0],
    ['묶음 보내기 숨김', c => c.doc.querySelector('#multiShare').style.display === 'none'],
  ]);
  fails += await runCase('양도 불가(C1 두 장)', '테스트열둘', '010-0000-1212',
    { n: '테스트열둘', c: 'TESTCODE12', t: [{ z: 'C1구역', s: '1열 1번' }, { z: 'C1구역', s: '1열 2번' }] }, [
    ['C1 좌석엔 공유 버튼 없음', c => c.doc.querySelectorAll('#tickets .t-sharebtn').length === 0],
    ['묶음 보내기 숨김', c => c.doc.querySelector('#multiShare').style.display === 'none'],
  ]);

  console.log('\n총 실패:', fails);
  process.exit(fails ? 1 : 0);
})();
