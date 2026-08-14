/* ============================================================
   설정 파일 — 회차가 바뀌면 여기만 수정하세요.
   ※ salt 를 바꾸면 db.json 을 반드시 다시 생성해야 합니다. (admin.html)
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TICKET_CONFIG = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  return {
    eventName: '신인감독 김연경2',
    eventSub: '직관 초대 티켓',
    eventInfo: '2026. 8. 20. (목) · 잠실학생체육관',

    // 티켓 하단 고지 문구
    noticeLines: [
      '* 본 티켓은 〈신인감독 김연경2〉 관계자를 통해 초대받은 수신자 본인만 사용 가능하며, 타인 사용 시 입장이 불가합니다.',
      '무단 유출 및 공유 시 법적 책임이 발생할 수 있습니다.',
    ],

    // 회차 고유값 — 회차(공연일)마다 다르게 설정 권장. 예: 'KYK2-JANGCHUNG-0827'
    salt: 'KYK2-JAMSIL-0820',

    // 암호화 강도(키 유도 반복 횟수). 변경 시 db.json 재생성 필요.
    iterations: 100000,
  };
});
