import { renderPage } from '../observability/theme.ts';

/**
 * Mobile-first combined page for the `user` role (item 3 of the request):
 * pick rooms and manage rules in one scroll, on the same
 * `/api/groups`/`/api/rules*` endpoints the admin-only `/groups` and
 * `/rules` pages already use — no separate backend logic. `admin` accounts
 * can also open this page; there is nothing on it that requires the admin
 * role.
 */
export const APP_HTML = renderPage({
  title: 'line-first-response · app',
  nav: [
    { href: '/app', label: 'หน้าหลัก', active: true },
    { href: '/account/logout', label: 'ออกจากระบบ' },
  ],
  bodyHtml: `
  <style>
    /* Wider reading area than the admin pages (item: "80% width, too narrow
       right now") — capped so it does not stretch absurdly on a big monitor,
       and dropped back to full width below 640px so mobile keeps the padding
       it already had rather than losing another 20% of a small screen. */
    .wrap{width:80%;max-width:56rem;margin:0 auto}
    @media (max-width:640px){
      .wrap{width:100%}
    }

    #groups{display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:.6rem}
    .room-row{display:flex;align-items:center;gap:.6rem;padding:.6rem .75rem;
      border:1px solid var(--rule);border-radius:6px;margin:0}
    .room-row input[type=checkbox]{width:1.3rem;height:1.3rem;flex:none}
    .room-name{font-family:var(--thai);flex:1}
    .room-kind{font-size:11px;color:var(--ink-faint);white-space:nowrap}

    .rule-list{display:flex;flex-direction:column;gap:.6rem}
    .rule-card{border:1px solid var(--rule);border-radius:6px;padding:.75rem .85rem}
    .rule-when{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-faint)}
    .rule-pattern{font-family:var(--thai);font-weight:600;margin-top:.2rem;word-break:break-word}
    .rule-reply{font-family:var(--thai);color:var(--ink-dim);margin-top:.4rem;word-break:break-word}
    .rule-actions{display:flex;gap:.5rem;margin-top:.65rem}

    button.primary{padding:.75rem 1.1rem;font-size:15px}
    details summary{cursor:pointer;color:var(--ink-dim);font-size:12px;margin:.5rem 0}

    /* Mobile: single column everywhere, full-width tap-friendly buttons. */
    @media (max-width:520px){
      #groups{grid-template-columns:1fr}
      .actions{flex-wrap:wrap}
      .actions button{flex:1 1 auto;min-width:8rem}
    }

    .speed-log{background:#111820;color:#d9e7ef;border-radius:8px;padding:.85rem 1rem;
      font:12px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;
      overflow:auto;min-height:7.2rem}
    .speed-log.good{color:#72e6a4}.speed-log.warn{color:#ffd166}.speed-log.bad{color:#ff7b86}
  </style>

  <section>
    <h2>เชื่อมต่อ LINE bot นี้</h2>
    <p class="note" id="sessionInfo">กำลังตรวจสอบ…</p>

    <div id="idleBox">
      <button type="button" class="primary" id="startBtn">เชื่อมต่อ LINE (สแกน QR)</button>
    </div>

    <div id="runningBox" hidden>
      <p class="note">สแกน QR นี้ด้วยแอป LINE ของบัญชีนี้ — LINE ให้เวลาประมาณ 150 วินาที</p>
      <div class="qr-wrap">
        <div id="qrHolder"></div>
        <p id="pinBox" hidden>หรือใส่ PIN นี้ในแอป: <span class="pin" id="pinValue"></span></p>
        <p class="dim" id="elapsed"></p>
      </div>
    </div>

    <div id="successBox" hidden>
      <p class="msg ok">สแกนสำเร็จ — กำลังเชื่อมบอทด้วย session ใหม่โดยอัตโนมัติ…</p>
      <p class="note">หน้านี้จะอัปเดตเองเมื่อบอทพร้อมใช้งาน</p>
    </div>

    <div id="errorBox" hidden>
      <p class="msg bad" id="errorMsg"></p>
      <button type="button" id="retryBtn">ลองใหม่</button>
    </div>

    <div class="actions">
      <button type="button" class="danger" id="logoutBtn" hidden>ยกเลิกการเชื่อมต่อ (logout)</button>
    </div>
    <p class="note" id="logoutNote"></p>
  </section>

  <p class="note msg" id="notConnectedNotice" hidden>
    ยังไม่เชื่อมต่อ LINE — สแกน QR ด้านบนก่อน เพื่อดูและตั้งค่าห้อง/กฎ
  </p>

  <section>
    <h2>สถานะความเร็ว (live log)</h2>
    <p class="note">ค่าหลักที่ใช้ตัดสินว่าชนะคือ <b>LINE TRIGGER→REPLY</b> ต้องไม่เกิน 30ms ใน p95 · RPC คือเวลาส่งจริง · INBOUND คือเวลาจาก LINE ถึงเรา</p>
    <pre id="speedLog" class="speed-log">กำลังอ่าน metrics…</pre>
  </section>

  <div id="managePanel">
    <section>
      <h2>ห้องที่บอตทำงาน</h2>
      <p class="note">เลือกห้องที่ต้องการให้บอตตอบ — บันทึกแล้วมีผลทันที ไม่ต้อง restart และไม่ต้องเข้าสู่ระบบใหม่</p>
      <div id="groups"><span class="dim">กำลังโหลด…</span></div>
      <div class="actions">
        <button type="button" id="refresh">รีเฟรชรายการ</button>
        <button type="button" class="primary" id="saveGroups" disabled>บันทึกห้อง</button>
      </div>
      <p id="groupsMsg" class="msg" hidden></p>
    </section>

    <section>
      <h2>กฎการตอบ</h2>
      <div id="rows" class="rule-list"></div>
      <p id="rulesMsg" class="msg" hidden></p>
    </section>

    <section>
      <h2 id="formTitle">เพิ่มกฎใหม่</h2>
      <form id="form">
        <input type="hidden" id="editingId" value="">
        <div class="field"><label for="pattern">เมื่อมีคนพิมพ์ว่า</label>
          <input type="text" id="pattern" required></div>
        <div class="field"><label for="reply">ให้บอทตอบว่า</label>
          <textarea id="reply" rows="2" required></textarea></div>
        <details>
          <summary>ตั้งค่าเพิ่มเติม (ไม่จำเป็น)</summary>
          <div class="row3">
            <div class="field"><label for="id">id</label><input type="text" id="id"></div>
            <div class="field"><label for="priority">priority</label><input type="number" id="priority" value="0"></div>
            <div class="field"><label for="kind">kind</label>
              <select id="kind">
                <option value="exact">exact</option>
                <option value="prefix">prefix</option>
                <option value="contains">contains</option>
              </select>
            </div>
          </div>
        </details>
        <div class="actions">
          <button type="submit" class="primary" id="submitBtn">เพิ่มกฎ</button>
          <button type="button" id="cancelBtn" hidden>ยกเลิกแก้ไข</button>
        </div>
      </form>
    </section>
  </div>`,
  script: `
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const speedMs = (v) => v === undefined || v === null ? '—' : v.toFixed(1) + 'ms';
const speedState = (v, budget) => v === undefined || v === null ? 'WAIT' : v <= budget ? 'OK' : 'SLOW';
function renderSpeedLog(status) {
  const metrics = status?.metrics ?? {};
  const spans = metrics.spans ?? {};
  const cross = metrics.crossHost ?? {};
  const row = (label, sample, budget) => {
    const value = sample?.p95;
    return label.padEnd(24) + ' p50=' + speedMs(sample?.p50).padStart(8) +
      ' p95=' + speedMs(value).padStart(8) + ' last=' + speedMs(sample?.last).padStart(8) +
      ' n=' + String(sample?.count ?? 0).padStart(4) + ' [' + speedState(value, budget) + ']';
  };
  const lines = [
    'LIVE SPEED STATUS  ' + new Date(status?.generatedAtMs ?? Date.now()).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' }),
    'TARGET: LINE TRIGGER-REPLY p95 <= 30.0ms',
    row('LINE TRIGGER-REPLY', cross.line_round_trip, 30),
    row('RPC (send ACK)', spans.send, 19),
    row('INBOUND (LINE->เรา)', cross.inbound, 11),
    row('CPU LOOP LAG' + (status?.host?.shard ? ' ' + status.host.shard : ''), status?.host?.loopLagMs, 5),
    'calls=' + String(metrics.counters?.line_calls ?? 0) + '  worker=' + String(status?.workerId ?? '—'),
  ];
  const el = $('speedLog');
  el.textContent = lines.join('\\n');
  const samples = [cross.line_round_trip, spans.send, cross.inbound];
  // Loop lag has its own, much lower line: a few ms of it is already a
  // machine that is short of CPU for the bots it runs.
  const starved = (status?.host?.loopLagMs?.p95 ?? 0) > 5;
  el.className = 'speed-log ' +
    (starved || samples.some((s) => s?.p95 !== undefined && s.p95 > 30) ? 'bad' : '');
}

async function loadSpeedStatus() {
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    if (!res.ok) throw new Error('status ' + res.status);
    renderSpeedLog(await res.json());
  } catch {
    $('speedLog').textContent = 'LIVE SPEED STATUS  unavailable\\nยังอ่าน metrics จาก worker ไม่ได้';
    $('speedLog').className = 'speed-log warn';
  }
}

function flash(el, text, ok) {
  el.textContent = text;
  el.className = 'msg ' + (ok ? 'ok' : 'bad');
  el.hidden = false;
}

/* In-page modal replacing alert()/confirm()/prompt() — styled via .modal-*
   in observability/theme.ts, shared by every admin/app page. */
function showModal(message, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box';
    const msg = document.createElement('p');
    msg.className = 'modal-msg';
    msg.textContent = message;
    box.appendChild(msg);
    const input = opts.prompt ? document.createElement('input') : null;
    if (input) {
      input.type = 'text';
      input.value = opts.defaultValue || '';
      box.appendChild(input);
    }
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const close = (result) => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(opts.alertOnly ? true : (opts.prompt ? null : false));
    };
    if (!opts.alertOnly) {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'ยกเลิก';
      cancel.addEventListener('click', () => close(opts.prompt ? null : false));
      actions.appendChild(cancel);
    }
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'primary';
    ok.textContent = opts.confirmLabel || 'ตกลง';
    ok.addEventListener('click', () => close(opts.prompt ? (input.value || '') : true));
    actions.appendChild(ok);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    (input || ok).focus();
  });
}
const showAlert = (message) => showModal(message, { alertOnly: true });
const showConfirm = (message, confirmLabel) => showModal(message, { confirmLabel: confirmLabel || 'ยืนยัน' });

/* ---- connect this bot to LINE (separate from the human account login) ---- */
const loginBoxes = ['idleBox', 'runningBox', 'successBox', 'errorBox'];
// null/undefined hides every box — used when already connected and idle,
// so the "scan QR" button does not show next to an account that is already
// logged in.
function showLoginBox(name) { loginBoxes.forEach((b) => { $(b).hidden = b !== name; }); }

// A room-surface change can briefly reconnect this bot. The worker keeps
// serving throughout; poll until its fresh runtime is ready and reload the
// page once rather than asking the person to refresh manually.
async function waitForServerThenReload(maxAttempts) {
  for (let i = 0; i < maxAttempts; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      await fetch('/api/health', { cache: 'no-store' });
      location.reload();
      return;
    } catch {
      // Not back up yet — keep waiting.
    }
  }
}

async function loadSessionInfo() {
  const res = await fetch('/api/login/status', { cache: 'no-store' });
  const body = await res.json();
  const s = body.botSession;
  $('sessionInfo').textContent = s
    ? 'บันทึกล่าสุด ' + new Date(s.savedAtMs).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }) +
      (s.expireSec ? ' · หมดอายุ ' + new Date(s.expireSec * 1000).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }) : '')
    : 'ยังไม่มี session ที่บันทึกไว้';
  $('logoutBtn').hidden = !s;
  return body;
}

let loginPoller = null;
function stopLoginPolling() { if (loginPoller) { clearInterval(loginPoller); loginPoller = null; } }

function syncLoginBox(body) {
  const f = body.flow;
  if (f.status === 'idle') { showLoginBox(body.botSession ? null : 'idleBox'); stopLoginPolling(); return; }
  if (f.status === 'running') {
    showLoginBox('runningBox');
    if (f.qrSvg) $('qrHolder').innerHTML = f.qrSvg;
    if (f.pin) { $('pinBox').hidden = false; $('pinValue').textContent = f.pin; }
    $('elapsed').textContent = typeof f.elapsedMs === 'number'
      ? 'ผ่านมา ' + Math.round(f.elapsedMs / 1000) + ' วินาที'
      : '';
    return;
  }
  // BotHost replaces this completed flow with a fresh, connected one after
  // the QR session is saved. Keep polling so the page reaches ready by
  // itself; no process or user-triggered restart is required.
  if (f.status === 'success') { showLoginBox('successBox'); return; }
  if (f.status === 'error') { $('errorMsg').textContent = f.message; showLoginBox('errorBox'); stopLoginPolling(); }
}

async function pollLoginFlow() {
  syncLoginBox(await loadSessionInfo());
}

$('startBtn').addEventListener('click', async () => {
  const res = await fetch('/api/login/start', { method: 'POST' });
  if (!res.ok) { const b = await res.json(); await showAlert(b.error || 'เริ่มไม่สำเร็จ'); return; }
  showLoginBox('runningBox');
  $('qrHolder').innerHTML = '';
  $('pinBox').hidden = true;
  loginPoller = setInterval(pollLoginFlow, 1500);
  pollLoginFlow();
});

$('logoutBtn').addEventListener('click', async () => {
  if (!(await showConfirm('ยกเลิกการเชื่อมต่อ LINE ของบอทนี้? ต้องสแกน QR ใหม่ และบอทจะ restart ทันที'))) return;
  $('logoutBtn').disabled = true;
  $('logoutNote').textContent = 'กำลังยกเลิกการเชื่อมต่อ…';
  try {
    const res = await fetch('/api/login/logout', { method: 'POST' });
    const body = await res.json();
    if (!res.ok) { $('logoutNote').textContent = body.error || 'ยกเลิกไม่สำเร็จ'; $('logoutBtn').disabled = false; return; }
    $('logoutNote').textContent = 'ยกเลิกแล้ว — กำลัง restart… หน้านี้จะรีโหลดให้อัตโนมัติ';
    waitForServerThenReload(20);
  } catch {
    $('logoutNote').textContent = 'ยกเลิกไม่สำเร็จ — ติดต่อบอทไม่ได้';
    $('logoutBtn').disabled = false;
  }
});

$('retryBtn').addEventListener('click', async () => {
  await fetch('/api/login/reset', { method: 'POST' });
  showLoginBox('idleBox');
});

loadSessionInfo().then((body) => {
  syncLoginBox(body);
  if (body.flow.status !== 'idle') loginPoller = setInterval(pollLoginFlow, 1500);
});

/* ---- rooms ---- */
// Rules/rooms are saved on the bot's own config file regardless of whether
// LINE is connected right now (editing them while disconnected is by
// design — see admin/server.ts). But showing a room flagged "LINE isn't
// returning this" and a stale rule list right after disconnecting reads as
// broken, not "saved for later" — so hide the panel instead, with one clear
// notice, while the data itself is untouched underneath.
function setManagePanelVisible(connected) {
  $('managePanel').hidden = !connected;
  $('notConnectedNotice').hidden = connected;
}

async function loadGroups() {
  $('refresh').disabled = true;
  try {
    const res = await fetch('/api/groups?refresh=' + Date.now(), { cache: 'no-store' });
    const body = await res.json();
    if (!res.ok) {
      $('groups').innerHTML = '<span class="bad">' + esc(body.error || 'โหลดไม่สำเร็จ') + '</span>';
      setManagePanelVisible(false);
      return;
    }
    setManagePanelVisible(body.connected);
    if (!body.connected) return;
    const groups = body.groups || [];
    $('groups').innerHTML = groups.length === 0
      ? '<p class="empty">LINE ยังไม่ส่งรายชื่อห้องกลับมา</p>'
      : groups.map((g) =>
        '<label class="room-row"><input type="checkbox" data-room="' + esc(g.id) + '" ' +
        (g.selected ? 'checked' : '') + '><span class="room-name">' + esc(g.name) +
        '</span><span class="room-kind">' + esc(g.kind) + '</span></label>').join('');
    $('saveGroups').disabled = groups.length === 0;
  } catch (err) {
    $('groups').innerHTML = '<span class="bad">โหลดไม่สำเร็จ</span>';
  } finally {
    $('refresh').disabled = false;
  }
}

$('refresh').addEventListener('click', () => {
  $('groups').innerHTML = '<span class="dim">กำลังรีเฟรช…</span>';
  loadGroups();
});

$('saveGroups').addEventListener('click', async () => {
  const roomIds = Array.from(document.querySelectorAll('[data-room]:checked')).map((n) => n.getAttribute('data-room'));
  if (roomIds.length === 0) { flash($('groupsMsg'), 'ต้องเลือกอย่างน้อย 1 ห้อง', false); return; }
  $('saveGroups').disabled = true;
  const res = await fetch('/api/groups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomIds }),
  });
  const body = await res.json();
  if (!res.ok) { flash($('groupsMsg'), body.error || 'บันทึกไม่สำเร็จ', false); $('saveGroups').disabled = false; return; }
  if (body.restarted) {
    flash($('groupsMsg'), 'บันทึกแล้ว กำลัง restart worker… หน้านี้จะรีโหลดให้อัตโนมัติ', true);
    waitForServerThenReload(20);
  } else {
    flash($('groupsMsg'), 'บันทึกแล้ว ใช้งานทันที', true);
    $('saveGroups').disabled = false;
  }
});

/* ---- rules ---- */
let currentRules = [];

function renderRows() {
  $('rows').innerHTML = currentRules.length === 0
    ? '<p class="empty">ยังไม่มีกฎ</p>'
    : currentRules.slice().sort((a, b) => b.priority - a.priority).map((r) =>
      '<div class="rule-card">' +
      '<div class="rule-when">เมื่อพิมพ์</div><div class="rule-pattern">' + esc(r.pattern) + '</div>' +
      '<div class="rule-when">ตอบว่า</div><div class="rule-reply">' + esc(r.reply) + '</div>' +
      '<div class="rule-actions">' +
      '<button type="button" data-edit="' + esc(r.id) + '">แก้</button>' +
      '<button type="button" class="danger" data-del="' + esc(r.id) + '">ลบ</button>' +
      '</div></div>').join('');
}

async function loadRules() {
  const res = await fetch('/api/rules', { cache: 'no-store' });
  const body = await res.json();
  currentRules = body.rules ?? [];
  renderRows();
}

function startEdit(rule) {
  $('editingId').value = rule.id;
  $('id').value = rule.id;
  $('priority').value = rule.priority;
  $('kind').value = rule.kind;
  $('pattern').value = rule.pattern;
  $('reply').value = rule.reply;
  $('formTitle').textContent = 'แก้กฎ';
  $('submitBtn').textContent = 'บันทึกการแก้ไข';
  $('cancelBtn').hidden = false;
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
}

function stopEdit() {
  $('form').reset();
  $('editingId').value = '';
  $('formTitle').textContent = 'เพิ่มกฎใหม่';
  $('submitBtn').textContent = 'เพิ่มกฎ';
  $('cancelBtn').hidden = true;
}
$('cancelBtn').addEventListener('click', stopEdit);

$('rows').addEventListener('click', async (e) => {
  const editId = e.target.getAttribute('data-edit');
  const delId = e.target.getAttribute('data-del');
  if (editId) {
    const rule = currentRules.find((r) => r.id === editId);
    if (rule) startEdit(rule);
  }
  if (delId) {
    if (!(await showConfirm('ลบกฎนี้?'))) return;
    const res = await fetch('/api/rules/' + encodeURIComponent(delId), { method: 'DELETE' });
    const body = await res.json();
    if (!res.ok) { flash($('rulesMsg'), body.error || 'ลบไม่สำเร็จ', false); return; }
    flash($('rulesMsg'), 'ลบกฎแล้ว', true);
    if ($('editingId').value === delId) stopEdit();
    loadRules();
  }
});

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const editingId = $('editingId').value;
  const payload = {
    id: $('id').value.trim() || (editingId || ('r' + Date.now())),
    priority: Number($('priority').value || 0),
    kind: $('kind').value,
    pattern: $('pattern').value,
    reply: $('reply').value,
  };
  const url = editingId ? '/api/rules/' + encodeURIComponent(editingId) : '/api/rules';
  const res = await fetch(url, {
    method: editingId ? 'PUT' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) { flash($('rulesMsg'), body.error || 'บันทึกไม่สำเร็จ', false); return; }
  flash($('rulesMsg'), editingId ? 'แก้กฎแล้ว' : 'เพิ่มกฎแล้ว — ใช้งานทันที', true);
  stopEdit();
  loadRules();
});

loadGroups();
loadRules();
loadSpeedStatus();
setInterval(loadSpeedStatus, 1000);`,
});
