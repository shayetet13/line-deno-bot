import { renderPage } from './theme.ts';

/**
 * The operator console, served by the worker itself.
 *
 * Read-only: shows readiness, latency, lanes, receive race and counters. It
 * only ever reads an already-assembled snapshot, so a dashboard left open
 * cannot add work to the reply path (Playbook §13.3). Mutating actions —
 * editing rules, re-authenticating a session — live on their own pages
 * (`/rules`, `/login`) that share this page's theme via `theme.ts`, not on
 * this one, so "look at status" and "change what the bot does" stay visibly
 * separate.
 */
export const DASHBOARD_HTML = renderPage({
  title: 'line-first-response · dashboard',
  nav: [
    { href: '/', label: 'dashboard', active: true },
    { href: '/groups', label: 'groups' },
    { href: '/rules', label: 'rules' },
    { href: '/login', label: 'login' },
  ],
  bodyHtml: `
  <section>
    <h2>readiness</h2>
    <div class="state"><span class="dot" id="rdot"></span><span id="rstate">—</span></div>
    <div class="checks" id="checks"></div>
    <p class="note" id="rreason"></p>
  </section>

  <section>
    <div class="lb-head">
      <h2>latency breakdown · rolling p50</h2>
      <span class="lb-calls">LINE CALLS<b id="lbCalls">—</b></span>
    </div>

    <div class="lb-equation" id="lbEquation"></div>
    <div class="lb-track"><span class="lb-fill" id="lbFill"></span></div>

    <div class="lb-roundtrip" id="lbRoundtrip"></div>

    <div class="lb-grid" id="lbGrid"></div>

    <p class="note">แต่ละช่องเป็น metric อิสระ จึงไม่ควรนำค่า p50 มาบวกหรือลบกัน · send RPC วัดบนนาฬิกาเดียว (transport_submit → ack_complete) · LINE ไป-กลับใช้ timestamp ของ LINE ทั้งต้นทางและปลายทางจึงใช้ตัดสินลำดับจริงได้ ส่วน inbound ใช้ดูแนวโน้มเท่านั้น</p>
  </section>

  <section>
    <h2>lanes</h2>
    <table>
      <thead><tr><th>lane</th><th>route จริง</th><th>role</th><th>badge</th><th>คะแนน</th><th>app p50</th><th>app p95</th><th>route est.</th><th>preflight</th><th>warm rtt</th><th>sample age</th><th>in-flight</th><th>fails</th></tr></thead>
      <tbody id="lanes"></tbody>
    </table>
    <p class="note">app p50/p95 = sendMessage จริงเท่านั้น · route est. = p50 + 35% ของช่วง p95−p50 ซึ่ง selector ใช้จริง · preflight = Square read-only สำหรับจัดลำดับเฉพาะเลนที่ยังไม่เคยส่ง และไม่ถูกนับเป็นเวลาส่งข้อความ · warm rtt = HEAD สำหรับอุ่น connection เท่านั้น ไม่ถูกนับเป็นเวลาส่งข้อความ · WAIT = ยังไม่มี send sample, sample เก่า, ถูกตัดเพราะเกิน 23ms, เป็น lane สำรอง, กำลังพัก cooldown หรือไม่พร้อม</p>
    <p class="note">คะแนน: 🐰 = ส่งจริงที่จบในเกณฑ์เร็ว · 🐢 = เกินเกณฑ์ ตอนที่ไม่มีใครใช้เลนร่วม · เลขในวงเล็บ = ช้าเพราะใช้เลนพร้อมกัน ซึ่งวัดคิวไม่ใช่วัดเส้นทาง จึงไม่แจกเต่า · 📌 = เลนที่ reply ปักอยู่ตอนนี้ จะย้ายก็ต่อเมื่อเลนนั้นเกินเกณฑ์เอง · นับเฉพาะ lane ฝั่ง send และรีเซ็ตเมื่อ lane ถูก recycle เพราะเป็นเส้นทางใหม่</p>
    <p class="note">สำรอง = เลน reply ที่กันไว้ ไม่ใช้ตอนปกติ จะถูกเรียกใช้เมื่อเลนหลักไม่ว่างทุกเลน (reply ซ้อนกัน/หลายบอท) — ตอนใช้สำรองเพราะเลนเต็ม ตัวปัก 📌 จะไม่ย้าย เพราะถือเป็นการล้นชั่วคราว ไม่ใช่เปลี่ยนเลนหลัก</p>
  </section>

  <section>
    <h2>receive race</h2>
    <table>
      <thead><tr><th>source</th><th>won first</th><th>seen</th></tr></thead>
      <tbody id="race"></tbody>
    </table>
    <p class="note">seen = ทุกครั้งที่ source นี้เจอข้อความ ไม่ว่าจะชนะหรือมาช้ากว่า — win 0% ไม่ใช่ตายเสมอไป ถ้า seen ยังสูงอยู่ก็แค่แพ้ race ทุกครั้ง (เช่น dedicated poll ที่ pollIntervalMs ต่ำมาก) source ที่ตายจริงจะ seen ตกไปด้วย</p>
  </section>

  <section>
    <h2>counters</h2>
    <table><tbody id="counters"></tbody></table>
  </section>`,
  script: `
const BUDGET = { send: 19, code: 0.5, local_total: 30, inbound: 11, line_round_trip: 30 };
const GUARD  = { send: 23 };
const $ = (id) => document.getElementById(id);
const ms = (v) => v === undefined || v === null ? '—' :
  v > 0 && v < 0.1 ? Math.round(v * 1000) + 'µs' : v.toFixed(1) + 'ms';
const sampleMeta = (s) => !s ? '' :
  'p95 ' + ms(s.p95) + ' · ล่าสุด ' + ms(s.last) + ' · n=' + s.count;
const cls = (span, v) => {
  const b = BUDGET[span]; if (b === undefined || v === undefined) return '';
  if (v <= b) return 'ok';
  return v <= (GUARD[span] ?? b * 1.5) ? 'warn' : 'bad';
};
const age = (v) => v === undefined || v === null ? '' :
  v < 1000 ? Math.round(v) + 'ms' : (v / 1000).toFixed(1) + 's';

function renderReadiness(r) {
  if (!r) { $('rstate').textContent = 'no readiness reported'; return; }
  $('rstate').textContent = r.state;
  const dot = $('rdot');
  dot.className = 'dot ' + (r.state === 'armed' ? 'ok' : r.state === 'degraded' ? 'bad' : 'warn');
  $('checks').innerHTML = Object.entries(r.checks)
    .map(([k, v]) => '<span class="chk' + (v ? ' on' : '') + '">' + k + '</span>').join('');
  $('rreason').textContent = r.reason ? 'เหตุผล: ' + r.reason : '';
}

// Every value below is a separately sampled rolling distribution. Percentiles
// from different distributions are intentionally never added or subtracted.
function renderLatencyBreakdown(metrics) {
  const spans = metrics?.spans ?? {};
  const crossHost = metrics?.crossHost ?? {};
  const counters = metrics?.counters ?? {};

  $('lbCalls').textContent = counters.line_calls ?? '—';

  const part = (label, budgetKey, s) =>
    '<span class="lb-num"><b class="v-' + (cls(budgetKey, s?.p50) || 'ok') + '">' +
    ms(s?.p50) + '</b><span class="dim">' + label + '</span>' +
    '<small class="dim">' + sampleMeta(s) + '</small></span>';

  $('lbEquation').innerHTML = spans.local_total === undefined &&
      crossHost.inbound === undefined && crossHost.line_round_trip === undefined
    ? '<div class="empty">ยังไม่มี sample</div>'
    : part('LINE trigger→reply', 'line_round_trip', crossHost.line_round_trip) +
      part('LINE→เรา (ประมาณ)', 'inbound', crossHost.inbound) +
      part('เราเห็น→ACK', 'local_total', spans.local_total) +
      part('send RPC ทั้งก้อน', 'send', spans.send);

  const primaryKey = crossHost.line_round_trip ? 'line_round_trip' : 'local_total';
  const total = crossHost.line_round_trip?.p50 ?? spans.local_total?.p50;
  const budget = BUDGET[primaryKey];
  const pct = total === undefined ? 0 : Math.min(100, (total / budget) * 100);
  const fill = $('lbFill');
  fill.style.width = pct + '%';
  fill.className = 'lb-fill ' + (cls(primaryKey, total) || 'ok');

  const rt = crossHost.line_round_trip;
  $('lbRoundtrip').innerHTML = rt === undefined
    ? '<p class="note dim">ยังไม่มี sample สำหรับ LINE ไป-กลับ (ต้องมีทั้ง trigger และ reply ที่มี timestamp จาก LINE)</p>'
    : '<span class="lb-rt-num">' + ms(rt.p50) + '<span class="dim">LINE ไป-กลับ · นาฬิกา LINE</span></span>' +
      '<p class="note">' + sampleMeta(rt) + ' · trigger→reply บน timestamp ของ LINE ตัวเดียว — ไม่มี clock skew ของเราที่จะตัดสินว่าใครตอบก่อนจริง</p>';

  const tile = (label, s, note, className = '') =>
    '<div class="lb-tile ' + className + '"><span class="lb-tile-label">' + label + '</span>' +
    '<span class="lb-tile-val">' + (s ? ms(s.p50) : 'N/A') + '</span>' +
    '<span class="lb-tile-note">' + (note || sampleMeta(s)) + '</span></div>';

  $('lbGrid').innerHTML =
    tile('LINE → เรา (ประมาณ)', crossHost.inbound) +
    tile('CODE ถึง transport', spans.code) +
    tile('Send RPC ทั้งก้อน', spans.send) +
    tile('เราเห็น → ACK', spans.local_total) +
    tile('LINE trigger → reply', crossHost.line_round_trip, undefined, 'line-trigger-reply');
}

// Rabbits and turtles come straight from the router's own tally. Nothing is
// recomputed here — a score the UI derived itself could disagree with the
// lane routing actually picked, which is the class of bug Playbook §10.9 is
// about.
function renderScore(score) {
  if (!score) return '<span class="dim">—</span>';
  const { rabbits, turtles, contendedSlow } = score;
  if (rabbits === 0 && turtles === 0 && contendedSlow === 0) {
    return '<span class="dim">ยังไม่มี send</span>';
  }
  const parts = [];
  if (rabbits > 0) parts.push('🐰 ' + rabbits);
  if (turtles > 0) parts.push('🐢 ' + turtles);
  const tally = parts.length > 0 ? parts.join(' ') : '<span class="dim">0</span>';
  return tally + (contendedSlow > 0 ? ' <span class="dim">(' + contendedSlow + ')</span>' : '');
}

function renderLanes(lanes) {
  $('lanes').innerHTML = lanes.length === 0
    ? '<tr><td colspan="13" class="empty">ไม่ได้เปิด owned lanes</td></tr>'
    : lanes.map((l) =>
        '<tr><td>#' + l.laneId + (l.currentSend ? ' 📌' : '') +
        ' <span class="dim">' + l.state + '</span></td>' +
        '<td class="dim">' + (l.remoteOrigin ? l.remoteOrigin.replace(/^https?:\\/\\//, '') +
          (l.remoteAddress ? ' → ' + l.remoteAddress : '') : (l.remoteAddress || 'resolver')) + '</td>' +
        '<td>' + (l.role || 'shared') +
        (l.spare ? ' <span class="dim">สำรอง</span>' : '') + '</td>' +
        '<td><span class="badge b-' + l.badge + '">' + l.badge.toUpperCase() + '</span></td>' +
        '<td>' + renderScore(l.score) + '</td>' +
        '<td>' + ms(l.applicationRttMs) + '</td>' +
        '<td>' + ms(l.tailRttMs) + '</td>' +
        '<td>' + ms(l.predictedRttMs) + '</td>' +
        '<td>' + ms(l.preflightRttMs) + '</td>' +
        '<td>' + ms(l.warmRttMs) + '</td>' +
        '<td class="age">' + (age(l.sampleAgeMs) || '—') + '</td>' +
        '<td class="' + ((l.role === 'poll' && l.inFlight > 1) ? 'v-bad' : '') + '">' + l.inFlight + '</td>' +
        '<td class="' + (l.consecutiveFailures > 0 ? 'v-bad' : 'dim') + '">' +
        l.consecutiveFailures + '</td></tr>').join('');
}

function renderRace(race) {
  if (!race) { $('race').innerHTML = '<tr><td colspan="3" class="empty">ไม่ได้เปิด race</td></tr>'; return; }
  const winTotal = Object.values(race.wins).reduce((a, b) => a + b, 0) || 1;
  const seenTotal = Object.values(race.seen ?? {}).reduce((a, b) => a + b, 0) || 1;
  $('race').innerHTML = Object.entries(race.wins).map(([src, n]) => {
    const seenN = race.seen?.[src] ?? 0;
    return '<tr><td>' + src + '</td><td>' + n +
      ' <span class="dim">' + Math.round((n / winTotal) * 100) + '%</span></td>' +
      '<td>' + seenN + ' <span class="dim">' + Math.round((seenN / seenTotal) * 100) + '%</span></td></tr>';
  }).join('') +
    '<tr><td class="dim">duplicates suppressed</td><td class="dim">' +
    race.duplicatesSuppressed + '</td><td></td></tr>';
}

function renderCounters(counters) {
  const rows = Object.entries(counters ?? {});
  $('counters').innerHTML = rows.length === 0
    ? '<tr><td class="empty">—</td></tr>'
    : rows.sort().map(([k, v]) => '<tr><td>' + k + '</td><td>' + v + '</td></tr>').join('');
}

async function tick() {
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    const s = await res.json();
    $('worker').textContent = s.workerId + ' · ' + s.origin;
    $('stamp').textContent = 'up ' + Math.floor(s.uptimeMs / 1000) + 's · ' +
      new Date(s.generatedAtMs).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' });
    renderReadiness(s.readiness);
    renderLatencyBreakdown(s.metrics);
    renderLanes(s.lanes ?? []);
    renderRace(s.race);
    renderCounters(s.metrics?.counters);
  } catch (err) {
    $('stamp').textContent = 'ติดต่อ worker ไม่ได้';
  }
}
tick();
setInterval(tick, 1000);`,
});
