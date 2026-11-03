// ==UserScript==
// @name         Shorts Limiter
// @name:ko      쇼츠 리미터
// @namespace    https://github.com/YOUR_GITHUB_ID/shorts-limiter
// @version      1.1.0
// @description  유튜브 쇼츠를 고정 윈도우(T분마다 N개)로 제한하고, 내가 많이 본 것과 오래 본 것을 보여줍니다. 기록은 내 브라우저에만 저장됩니다.
// @author       YOUR_NAME
// @license      MIT
// @match        https://www.youtube.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// @supportURL   https://github.com/YOUR_GITHUB_ID/shorts-limiter/issues
// @updateURL    https://raw.githubusercontent.com/YOUR_GITHUB_ID/shorts-limiter/main/src/shorts-limiter.user.js
// @downloadURL  https://raw.githubusercontent.com/YOUR_GITHUB_ID/shorts-limiter/main/src/shorts-limiter.user.js
// ==/UserScript==

/*
 * Shorts Limiter v1.1.0
 * 실행 환경: Violentmonkey(오픈소스, 권장) / Tampermonkey
 *
 * 규칙
 *  - 고정 윈도우: 하루를 T분 구간으로 나눔 (T=30 → 23:00~23:30, 23:30~00:00 ...)
 *  - 한 구간에서 쇼츠를 N개 보면, 구간이 끝날 때까지 차단 화면
 *  - 쇼츠에 "들어가는 순간" 1개로 카운트 (1초 만에 넘겨도 1개)
 *
 * 기록
 *  - 영상 ID, 제목, 채널, 진입·이탈 시각, 체류 시간(탭이 보이던 시간만), 차단 여부
 *  - 브라우저(매니저 저장소)에만 저장. 외부 전송 없음. 내보내기는 사용자가 직접 실행
 */

(function () {
  'use strict';

  // ───────────────────────── 설정 ─────────────────────────
  const CONFIG = {
    WINDOW_MINUTES: 30,           // T: 고정 윈도우 길이(분)
    MAX_VIDEOS: 20,               // N: 한 구간에서 허용하는 영상 수
    META_DELAYS_MS: [1200, 3000, 6000], // 제목·채널을 다시 읽는 시점
    POLL_MS: 1000,                // 주소 변경 감지 보조 주기
  };
  const VERSION = '1.1.0';
  const KEY_LOGS = 'sl_logs';
  const KEY_USER = 'sl_user';
  const KEY_INSTALLED = 'sl_installed_at';
  const WINDOW_MS = CONFIG.WINDOW_MINUTES * 60 * 1000;

  // ───────────────────────── 저장소 ─────────────────────────
  const loadLogs = () => GM_getValue(KEY_LOGS, []);
  const saveLogs = (logs) => GM_setValue(KEY_LOGS, logs);

  // 처음 실행 시 익명 ID 자동 발급 (여러 테스터 로그를 합쳐도 겹치지 않게)
  function getUser() {
    let id = GM_getValue(KEY_USER, '');
    if (!id) {
      id = 'user-' + Math.random().toString(36).slice(2, 6);
      GM_setValue(KEY_USER, id);
      GM_setValue(KEY_INSTALLED, Date.now());
    }
    return id;
  }

  function appendEntry(entry) {
    const logs = loadLogs();
    logs.push(entry);
    saveLogs(logs);
  }

  function updateEntry(id, patch) {
    const logs = loadLogs();
    const e = logs.find((l) => l.id === id);
    if (e) {
      Object.assign(e, patch);
      saveLogs(logs);
    }
  }

  // ───────────────────────── 고정 윈도우 ─────────────────────────
  // 로컬 시각 기준으로 구간 정렬 (KST라면 매 정각·30분에 초기화)
  function windowStartOf(t) {
    const offset = new Date(t).getTimezoneOffset() * 60000;
    return Math.floor((t - offset) / WINDOW_MS) * WINDOW_MS + offset;
  }

  // 현재 구간에서 이미 본(차단되지 않은) 영상 수
  function countInWindow(ws) {
    return loadLogs().filter((l) => !l.blocked && l.enteredAt >= ws && l.enteredAt < ws + WINDOW_MS).length;
  }

  const pad = (n) => String(n).padStart(2, '0');
  const fmtTime = (t) => {
    const d = new Date(t);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  // ───────────────────────── 시청 상태 ─────────────────────────
  let current = null; // { id, videoId, enteredAt, visibleMs, visibleSince }
  let lastPath = null;

  const getShortId = (path) => {
    const m = path.match(/^\/shorts\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  };

  function onLocationChange() {
    const path = location.pathname;
    if (path === lastPath) return;
    lastPath = path;

    leaveCurrent();
    const videoId = getShortId(path);
    if (videoId) enterShort(videoId);
    else removeOverlay();
  }

  function enterShort(videoId) {
    const now = Date.now();
    const ws = windowStartOf(now);
    const used = countInWindow(ws);

    const base = {
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      userTag: getUser(),
      videoId,
      title: '',
      channel: '',
      enteredAt: now,
      leftAt: null,
      dwellMs: null,
      visibleMs: null,
      windowStart: ws,
      windowMinutes: CONFIG.WINDOW_MINUTES,
      maxVideos: CONFIG.MAX_VIDEOS,
      countBefore: used,
      scriptVersion: VERSION,
    };

    if (used >= CONFIG.MAX_VIDEOS) {
      appendEntry({ ...base, blocked: true }); // 차단된 시도도 기록
      showOverlay(ws, ws + WINDOW_MS);
      return;
    }

    removeOverlay();
    appendEntry({ ...base, blocked: false });
    current = {
      id: base.id,
      videoId,
      enteredAt: now,
      visibleMs: 0,
      visibleSince: document.visibilityState === 'visible' ? now : null,
    };
    fetchOEmbed(base.id, videoId);
    CONFIG.META_DELAYS_MS.forEach((d) => setTimeout(() => captureMeta(base.id, videoId), d));
  }

  // 유튜브 공식 oEmbed(같은 youtube.com 주소)로 제목·채널 조회
  // → 화면 구조가 바뀌어도 영향을 받지 않음. 실패하면 화면에서 읽은 값만 사용
  async function fetchOEmbed(id, videoId) {
    try {
      const target = encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`);
      const res = await fetch(`/oembed?url=${target}&format=json`, { credentials: 'omit' });
      if (!res.ok) return;
      const data = await res.json();
      const patch = {};
      if (data.author_name) patch.channel = data.author_name;
      if (data.title) patch.oembedTitle = data.title;
      const entry = loadLogs().find((l) => l.id === id);
      if (entry && !entry.title && data.title) patch.title = data.title;
      if (Object.keys(patch).length) updateEntry(id, patch);
    } catch (_) { /* 네트워크 실패 시 무시 */ }
  }

  function leaveCurrent() {
    if (!current) return;
    const now = Date.now();
    let visible = current.visibleMs;
    if (current.visibleSince) visible += now - current.visibleSince;
    updateEntry(current.id, {
      leftAt: now,
      dwellMs: now - current.enteredAt,
      visibleMs: visible,
    });
    current = null;
  }

  // 탭이 숨겨진 시간은 체류 시간에서 제외
  document.addEventListener('visibilitychange', () => {
    if (!current) return;
    const now = Date.now();
    if (document.visibilityState === 'hidden') {
      if (current.visibleSince) {
        current.visibleMs += now - current.visibleSince;
        current.visibleSince = null;
      }
    } else if (!current.visibleSince) {
      current.visibleSince = now;
    }
  });
  window.addEventListener('pagehide', leaveCurrent);

  // ───────────────────────── 제목·채널 읽기 ─────────────────────────
  // 유튜브 화면 구조가 자주 바뀌므로 여러 후보를 순서대로 시도
  const ACTIVE = 'ytd-reel-video-renderer[is-active]';

  function firstText(selectors) {
    for (const s of selectors) {
      const el = document.querySelector(s);
      const t = el && el.textContent.replace(/\s+/g, ' ').trim();
      if (t) return t;
    }
    return '';
  }

  function readTitle() {
    const fromDoc = document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube\s*$/, '').trim();
    if (fromDoc && fromDoc !== 'YouTube') return fromDoc;
    return firstText([
      `${ACTIVE} h2`,
      `${ACTIVE} .ytShortsVideoTitleViewModelShortsVideoTitle`,
      `${ACTIVE} yt-shorts-video-title-view-model`,
    ]);
  }

  function readChannel() {
    return firstText([
      `${ACTIVE} .ytReelChannelBarViewModelChannelName a`,
      `${ACTIVE} yt-reel-channel-bar-view-model a`,
      `${ACTIVE} #channel-name a`,
      `${ACTIVE} ytd-channel-name a`,
      `${ACTIVE} a[href^="/@"]`,
    ]);
  }

  function captureMeta(id, videoId) {
    // 아직 같은 영상에 머물러 있을 때만 읽음 (다음 영상 제목이 섞이는 것 방지)
    if (!current || current.id !== id || getShortId(location.pathname) !== videoId) return;
    const patch = {};
    const title = readTitle();
    const channel = readChannel();
    const entry = loadLogs().find((l) => l.id === id);
    if (title) patch.title = title;
    if (channel && entry && !entry.channel) patch.channel = channel; // oEmbed 값이 있으면 우선
    if (Object.keys(patch).length) updateEntry(id, patch);
  }

  // ───────────────────────── 시청 분석 ─────────────────────────
  // "많이 본 것"(횟수)      = 알고리즘이 계속 보여줘서 무의식적으로 넘긴 것
  // "오래 본 것"(평균 시간) = 내가 실제로 멈춰서 본 것
  const SKIP_MS = 3000;                 // 3초 안에 넘기면 '스킵'
  const OUTLIER_MS = 10 * 60 * 1000;    // 10분 넘게 머문 건 자리 비움으로 보고 시간 통계에서 제외
  const GENERIC_TAGS = new Set([
    'shorts', 'short', 'shortsvideo', 'youtubeshorts', 'shortsfeed', 'shortvideo',
    '쇼츠', 'fyp', 'foryou', 'viral', 'trending', '추천', '알고리즘',
  ]);

  // 주제 = 제목의 해시태그. 해시태그가 없으면 채널로 대신함
  function topicsOf(l) {
    const tags = ((l.title || '').match(/#[^\s#]+/g) || [])
      .map((t) => t.slice(1).replace(/[.,!?)\]]+$/, '').toLowerCase())
      .filter((t) => t && !GENERIC_TAGS.has(t));
    if (tags.length) return [...new Set(tags)].map((t) => '#\u2060' + t); // \u2060: '#' 뒤에서 줄이 바뀌지 않게
    return l.channel ? ['📺 ' + l.channel] : [];
  }

  function analyze(logs, minDwellCount) {
    const watched = logs.filter((l) => !l.blocked);
    const map = new Map();
    const hours = new Array(24).fill(0);
    let totalMs = 0, timed = 0, skipped = 0;
    for (const l of watched) {
      hours[new Date(l.enteredAt).getHours()]++;
      const ms = l.visibleMs;
      const valid = ms != null && ms <= OUTLIER_MS;
      if (valid) {
        totalMs += ms;
        timed++;
        if (ms < SKIP_MS) skipped++;
      }
      for (const t of topicsOf(l)) {
        const m = map.get(t) || { name: t, count: 0, ms: 0, timed: 0 };
        m.count++;
        if (valid) { m.ms += ms; m.timed++; }
        map.set(t, m);
      }
    }
    const topics = [...map.values()].map((m) => ({ ...m, avgMs: m.timed ? m.ms / m.timed : 0 }));
    return {
      watched: watched.length,
      blocked: logs.length - watched.length,
      totalMs,
      skipRate: timed ? skipped / timed : null,
      hours,
      byCount: [...topics].sort((a, b) => b.count - a.count || b.avgMs - a.avgMs),
      byDwell: topics.filter((m) => m.timed >= minDwellCount).sort((a, b) => b.avgMs - a.avgMs),
    };
  }

  function fmtDur(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}초`;
    const m = Math.floor(s / 60);
    if (m < 60) return s % 60 ? `${m}분 ${s % 60}초` : `${m}분`;
    return `${Math.floor(m / 60)}시간 ${m % 60}분`;
  }

  function insightOf(a) {
    const many = a.byCount[0];
    const long = a.byDwell[0];
    if (!many) return '';
    if (!long) return '기록이 조금 더 쌓이면 오래 본 것도 알려드릴게요.';
    if (many.name === long.name) return `많이 본 것도, 오래 본 것도 ${many.name}.`;
    return `많이 본 것과 오래 본 것이 달라요. 자주 넘긴 건 ${many.name}, 멈춰서 본 건 ${long.name}.`;
  }

  // ───────────────────────── 차단 화면 ─────────────────────────
  // 유튜브는 Trusted Types 정책 때문에 innerHTML 대신 DOM API로만 그림
  let overlay = null;
  let countdownTimer = null;
  let pauseTimer = null;

  function pauseVideos() {
    document.querySelectorAll('video').forEach((v) => {
      try { v.pause(); v.muted = true; } catch (_) { /* ignore */ }
    });
  }

  function el(tag, text, style) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (style) Object.assign(node.style, style);
    return node;
  }

  function showOverlay(ws, reopenAt) {
    pauseVideos();
    if (!overlay) {
      overlay = el('div', '', {
        position: 'fixed', inset: '0', zIndex: '2147483647',
        background: 'rgba(15,15,15,0.96)', color: '#fff',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: '14px', padding: '24px',
        fontFamily: 'system-ui, -apple-system, "Malgun Gothic", sans-serif', textAlign: 'center', wordBreak: 'keep-all',
      });
      overlay.id = 'sl-overlay';
      document.body.appendChild(overlay);
    }

    const title = el('div', '쇼츠 시청 한도에 도달했어요', { fontSize: '28px', fontWeight: '700' });
    const desc = el('div',
      `이번 구간(${fmtTime(ws)} ~ ${fmtTime(reopenAt)})에 쇼츠 ${CONFIG.MAX_VIDEOS}개를 모두 봤습니다.`,
      { fontSize: '16px', opacity: '0.85' });
    const remain = el('div', '', { fontSize: '40px', fontWeight: '700', fontVariantNumeric: 'tabular-nums' });
    const reopen = el('div', `${fmtTime(reopenAt)}에 다시 열립니다`, { fontSize: '15px', opacity: '0.7' });

    // 이번 구간 요약: 방금 무엇을 넘기고, 무엇에 멈췄는지
    const summary = buildWindowSummary(ws, reopenAt);

    const btnRow = el('div', '', { display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center', marginTop: '6px' });
    const btnStyle = {
      padding: '10px 22px', fontSize: '15px', borderRadius: '20px', border: 'none', cursor: 'pointer',
    };
    const reportBtn = el('button', '📈 내 시청 리포트', { ...btnStyle, background: 'rgba(255,255,255,0.15)', color: '#fff' });
    reportBtn.addEventListener('click', () => openReport('today'));
    const homeBtn = el('button', '유튜브 홈으로', { ...btnStyle, background: '#fff', color: '#111' });
    homeBtn.addEventListener('click', () => { location.href = '/'; });
    btnRow.append(reportBtn, homeBtn);
    overlay.replaceChildren(title, desc, summary, remain, reopen, btnRow);

    const tick = () => {
      const left = reopenAt - Date.now();
      if (left <= 0) {
        // 구간이 바뀜 → 차단 해제, 지금 화면의 영상을 새 구간 첫 영상으로 처리
        removeOverlay();
        lastPath = null;
        onLocationChange();
        return;
      }
      remain.textContent = `${pad(Math.floor(left / 60000))}:${pad(Math.floor((left % 60000) / 1000))}`;
    };
    clearInterval(countdownTimer);
    clearInterval(pauseTimer);
    tick();
    countdownTimer = setInterval(tick, 1000);
    pauseTimer = setInterval(pauseVideos, 500); // 쇼츠 자동재생 억제
  }

  function removeOverlay() {
    clearInterval(countdownTimer);
    clearInterval(pauseTimer);
    countdownTimer = pauseTimer = null;
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
  }

  function buildWindowSummary(ws, we) {
    const a = analyze(loadLogs().filter((l) => l.enteredAt >= ws && l.enteredAt < we), 2);
    const box = el('div', '', {
      background: 'rgba(255,255,255,0.08)', borderRadius: '14px', padding: '16px 20px',
      width: '100%', maxWidth: '460px', boxSizing: 'border-box', textAlign: 'left',
      display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '15px', lineHeight: '1.5',
    });
    box.appendChild(el('div', `이번 ${CONFIG.WINDOW_MINUTES}분 동안 쇼츠 ${a.watched}개 · 총 시청 ${fmtDur(a.totalMs)}`, { fontWeight: '600' }));
    const many = a.byCount[0];
    const long = a.byDwell[0];
    if (many) box.appendChild(el('div', `🔁 가장 많이 본 것  ${many.name} ${many.count}개 (평균 ${fmtDur(many.avgMs)})`));
    if (long) box.appendChild(el('div', `⏱ 가장 오래 본 것  ${long.name} ${long.count}개 (평균 ${fmtDur(long.avgMs)})`));
    const insight = insightOf(a);
    if (insight) box.appendChild(el('div', insight, { fontSize: '13px', opacity: '0.7' }));
    return box;
  }

  // ───────────────────────── 내 시청 리포트 ─────────────────────────
  let report = null;
  const PERIODS = [['today', '오늘'], ['week', '최근 7일'], ['all', '전체']];
  const RC = {
    count: '#4ea1ff',   // 많이 본 것
    dwell: '#ffb347',   // 오래 본 것
    panel: '#1f1f1f',
    track: 'rgba(255,255,255,0.10)',
    dim: 'rgba(255,255,255,0.65)',
  };
  const FONT = 'system-ui, -apple-system, "Malgun Gothic", sans-serif';

  function periodLogs(p) {
    const logs = loadLogs();
    if (p === 'all') return logs;
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    const from = p === 'today' ? d.getTime() : d.getTime() - 6 * 86400000;
    return logs.filter((l) => l.enteredAt >= from);
  }

  function barList(items, valueOf, labelOf, color) {
    const box = el('div', '', { display: 'flex', flexDirection: 'column', gap: '10px' });
    if (!items.length) {
      box.appendChild(el('div', '아직 기록이 부족해요', { color: RC.dim, fontSize: '13px' }));
      return box;
    }
    const max = Math.max(...items.map(valueOf)) || 1;
    for (const it of items) {
      const row = el('div', '', {
        display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: '4px 10px', alignItems: 'center',
      });
      const name = el('div', it.name, { fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
      const val = el('div', labelOf(it), { fontSize: '13px', color: RC.dim, whiteSpace: 'nowrap' });
      const track = el('div', '', { gridColumn: '1 / -1', height: '8px', background: RC.track, borderRadius: '4px', overflow: 'hidden' });
      track.appendChild(el('div', '', {
        height: '100%', width: `${Math.max(3, (valueOf(it) / max) * 100)}%`, background: color, borderRadius: '4px',
      }));
      row.append(name, val, track);
      box.appendChild(row);
    }
    return box;
  }

  function hourChart(hours) {
    const max = Math.max(...hours) || 1;
    const wrap = el('div', '', { display: 'flex', flexDirection: 'column', gap: '4px' });
    const bars = el('div', '', { display: 'flex', alignItems: 'flex-end', gap: '2px', height: '64px' });
    hours.forEach((n, h) => {
      const b = el('div', '', {
        flex: '1', height: `${n ? Math.max(4, (n / max) * 100) : 0}%`, background: RC.count,
        borderRadius: '3px 3px 0 0', minWidth: '0',
      });
      b.title = `${h}시: ${n}개`;
      bars.appendChild(b);
    });
    const axis = el('div', '', { display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: RC.dim });
    ['0시', '6시', '12시', '18시', '23시'].forEach((t) => axis.appendChild(el('span', t)));
    wrap.append(bars, axis);
    return wrap;
  }

  function section(titleText, subText, body) {
    const s = el('div', '', { display: 'flex', flexDirection: 'column', gap: '10px', minWidth: '0' });
    s.appendChild(el('div', titleText, { fontSize: '16px', fontWeight: '700' }));
    if (subText) s.appendChild(el('div', subText, { fontSize: '12px', color: RC.dim, marginTop: '-6px' }));
    s.appendChild(body);
    return s;
  }

  // 리포트가 열려 있는 동안 유튜브 단축키(↑↓, 스페이스 등)로 뒤의 쇼츠가 넘어가지 않게 막음
  function onReportKey(e) {
    if (!report) return;
    if (e.key === 'Escape') closeReport();
    e.stopImmediatePropagation();
  }

  function closeReport() {
    window.removeEventListener('keydown', onReportKey, true);
    if (report) {
      report.remove();
      report = null;
    }
  }

  function openReport(period) {
    if (!report) {
      report = el('div', '', {
        position: 'fixed', inset: '0', zIndex: '2147483647', background: 'rgba(0,0,0,0.72)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px',
        boxSizing: 'border-box', fontFamily: FONT, color: '#fff', wordBreak: 'keep-all',
      });
      report.id = 'sl-report';
      report.addEventListener('click', (e) => { if (e.target === report) closeReport(); });
      report.addEventListener('wheel', (e) => e.stopPropagation());
      window.addEventListener('keydown', onReportKey, true);
      document.body.appendChild(report);
    }

    const a = analyze(periodLogs(period), 3);
    const panel = el('div', '', {
      background: RC.panel, borderRadius: '16px', width: '100%', maxWidth: '720px', maxHeight: '90vh',
      overflowY: 'auto', padding: '22px 24px', boxSizing: 'border-box',
      display: 'flex', flexDirection: 'column', gap: '20px', textAlign: 'left',
    });

    // 머리글
    const head = el('div', '', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' });
    const close = el('button', '✕', {
      background: 'none', border: 'none', color: '#fff', fontSize: '20px', cursor: 'pointer', padding: '4px 8px',
    });
    close.setAttribute('aria-label', '닫기');
    close.addEventListener('click', closeReport);
    head.append(el('div', '📈 내 시청 리포트', { fontSize: '20px', fontWeight: '700' }), close);

    // 기간 탭
    const tabs = el('div', '', { display: 'flex', gap: '6px', flexWrap: 'wrap' });
    for (const [key, label] of PERIODS) {
      const on = key === period;
      const b = el('button', label, {
        padding: '6px 14px', borderRadius: '16px', fontSize: '13px', cursor: 'pointer',
        border: `1px solid ${on ? '#fff' : 'rgba(255,255,255,0.25)'}`,
        background: on ? '#fff' : 'transparent', color: on ? '#111' : '#fff', fontWeight: on ? '700' : '400',
      });
      b.addEventListener('click', () => openReport(key));
      tabs.appendChild(b);
    }
    panel.append(head, tabs);

    if (!a.watched) {
      panel.appendChild(el('div', '이 기간에는 기록이 없어요.', { color: RC.dim, padding: '24px 0' }));
      report.replaceChildren(panel);
      return;
    }

    // 요약 숫자
    const stats = el('div', '', { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px' });
    const stat = (label, value) => {
      const c = el('div', '', { background: 'rgba(255,255,255,0.06)', borderRadius: '12px', padding: '12px 14px' });
      c.append(el('div', label, { fontSize: '12px', color: RC.dim }), el('div', value, { fontSize: '22px', fontWeight: '700', marginTop: '2px' }));
      stats.appendChild(c);
    };
    stat('본 쇼츠', `${a.watched}개`);
    stat('총 시청 시간', fmtDur(a.totalMs));
    stat('3초 안에 넘긴 비율', a.skipRate == null ? '-' : `${Math.round(a.skipRate * 100)}%`);
    stat('차단된 시도', `${a.blocked}회`);

    // 한 줄 해석
    const insight = el('div', insightOf(a) || ' ', {
      fontSize: '15px', lineHeight: '1.5', padding: '12px 14px', borderRadius: '12px',
      background: 'rgba(255,255,255,0.06)', borderLeft: `3px solid ${RC.dwell}`,
    });

    // 많이 본 것 vs 오래 본 것
    const cols = el('div', '', { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '22px' });
    cols.append(
      section('🔁 가장 많이 본 것', '횟수 순 · 알고리즘이 자주 보여준 것',
        barList(a.byCount.slice(0, 5), (it) => it.count, (it) => `${it.count}개 · 평균 ${fmtDur(it.avgMs)}`, RC.count)),
      section('⏱ 가장 오래 본 것', '평균 시청 시간 순 · 3개 이상 본 주제',
        barList(a.byDwell.slice(0, 5), (it) => it.avgMs, (it) => `평균 ${fmtDur(it.avgMs)} · ${it.count}개`, RC.dwell)),
    );

    panel.append(
      stats,
      insight,
      cols,
      section('🕐 시간대별 시청', '몇 시에 쇼츠를 많이 봤는지', hourChart(a.hours)),
      el('div', '주제는 제목의 해시태그로 나누고, 해시태그가 없으면 채널(📺)로 대신해요. 기록은 이 브라우저에만 저장됩니다.',
        { fontSize: '12px', color: RC.dim, lineHeight: '1.5' }),
    );
    report.replaceChildren(panel);
  }

  // ───────────────────────── 내보내기 ─────────────────────────
  function stamp() {
    const d = new Date();
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  function exportLogs(anonymize) {
    let logs = loadLogs();
    if (anonymize) {
      logs = logs.map((l) => ({ ...l, title: '', channel: '', videoId: '' }));
    }
    const payload = {
      meta: {
        scriptVersion: VERSION,
        userTag: getUser(),
        installedAt: GM_getValue(KEY_INSTALLED, null),
        exportedAt: new Date().toISOString(),
        timezoneOffsetMin: new Date().getTimezoneOffset(),
        windowMinutes: CONFIG.WINDOW_MINUTES,
        maxVideos: CONFIG.MAX_VIDEOS,
        anonymized: anonymize,
      },
      logs,
    };
    const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `shorts_log_${getUser()}_${stamp()}${anonymize ? '_anon' : ''}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ───────────────────────── 메뉴 (확장 프로그램 아이콘) ─────────────────────────
  GM_registerMenuCommand('📈 내 시청 리포트', () => openReport('today'));

  GM_registerMenuCommand('📊 현재 상태 보기', () => {
    const now = Date.now();
    const ws = windowStartOf(now);
    const logs = loadLogs();
    alert(
      `쇼츠 리미터 v${VERSION}\n` +
      `내 ID: ${getUser()}\n` +
      `규칙: ${CONFIG.WINDOW_MINUTES}분마다 ${CONFIG.MAX_VIDEOS}개\n` +
      `현재 구간: ${fmtTime(ws)} ~ ${fmtTime(ws + WINDOW_MS)}\n` +
      `이번 구간 시청: ${countInWindow(ws)} / ${CONFIG.MAX_VIDEOS}\n` +
      `전체 기록: ${logs.length}건 (차단 시도 ${logs.filter((l) => l.blocked).length}건)`
    );
  });

  GM_registerMenuCommand('💾 기록 내보내기', () => exportLogs(false));
  GM_registerMenuCommand('🕶 기록 내보내기 (제목·채널 빼고)', () => exportLogs(true));

  GM_registerMenuCommand('🔍 최근 기록 확인 (동작 점검)', () => {
    const recent = loadLogs().slice(-5).reverse();
    if (!recent.length) {
      alert('아직 기록이 없습니다. 쇼츠를 몇 개 넘겨본 뒤 다시 확인해주세요.');
      return;
    }
    const lines = recent.map((l, i) => {
      if (l.blocked) {
        return `${i + 1}. ${fmtTime(l.enteredAt)} · 차단됨 (이번 구간 ${l.countBefore}개 시청 후)`;
      }
      const sec = l.visibleMs != null ? `${Math.round(l.visibleMs / 1000)}초` : '시청 중';
      return `${i + 1}. ${fmtTime(l.enteredAt)} · ${sec}\n   제목: ${l.title || '(못 읽음)'}\n   채널: ${l.channel || '(못 읽음)'}`;
    });
    alert('최근 기록 5건\n\n' + lines.join('\n'));
  });

  GM_registerMenuCommand('🗑 기록 초기화', () => {
    if (confirm('저장된 시청 기록을 모두 지울까요?\n먼저 "기록 내보내기"를 해두는 걸 권장합니다.')) {
      saveLogs([]);
    }
  });

  // ───────────────────────── 시작 ─────────────────────────
  getUser();
  window.addEventListener('yt-navigate-finish', onLocationChange); // 유튜브 페이지 이동 이벤트
  setInterval(onLocationChange, CONFIG.POLL_MS);                   // 보조 감지
  onLocationChange();
})();
