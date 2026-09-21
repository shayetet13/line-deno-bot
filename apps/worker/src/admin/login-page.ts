import { renderPage } from '../observability/theme.ts';

/**
 * LINE bot session re-authentication from a browser: scan a QR without needing an SSH
 * session and a real terminal. See `admin/login-flow.ts` for why this is a
 * re-auth tool, not a first-time bootstrap tool, and why a fresh login here
 * needs a worker restart to take effect rather than hot-swapping the live
 * connection.
 */
export const LOGIN_HTML = renderPage({
  title: 'line-first-response · LINE bot login',
  nav: [
    { href: '/', label: 'dashboard' },
    { href: '/groups', label: 'groups' },
    { href: '/rules', label: 'rules' },
    { href: '/login', label: 'LINE bot login', active: true },
    { href: '/users', label: 'users' },
    { href: '/account/logout', label: 'ออกจากระบบ' },
  ],
  bodyHtml: `
  <section>
    <h2>LINE bot session ปัจจุบัน</h2>
    <p id="sessionInfo" class="note">กำลังตรวจสอบ…</p>
    <div class="actions">
      <button type="button" class="danger" id="logoutBtn" hidden>ออกจากระบบ (logout)</button>
    </div>
    <p class="note" id="logoutNote"></p>
  </section>

  <section>
    <h2>เข้าสู่ระบบ LINE bot ใหม่ (QR)</h2>
    <p class="note">ใช้เมื่อ session เดิมหมดอายุหรือถูกปฏิเสธ ไม่ใช่การตั้งค่าบอทใหม่ตั้งแต่ต้น — บอทใหม่ต้องใช้
      <code>deno task login</code> ทาง terminal ก่อน เพราะยังไม่มี worker รันให้เปิดหน้านี้</p>

    <div id="idleBox">
      <button type="button" class="primary" id="startBtn">เริ่มเข้าสู่ระบบใหม่</button>
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
      <p class="msg ok">เข้าสู่ระบบสำเร็จ — บันทึก session ใหม่แล้ว ต้อง restart worker เพื่อใช้ session นี้</p>
      <div class="actions">
        <button type="button" class="primary" id="restartBtn">Restart worker ตอนนี้</button>
      </div>
      <p class="note" id="restartNote"></p>
    </div>

    <div id="errorBox" hidden>
      <p class="msg bad" id="errorMsg"></p>
      <button type="button" id="retryBtn">ลองใหม่</button>
    </div>
  </section>`,
  script: `
const $ = (id) => document.getElementById(id);

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

const boxes = ['idleBox', 'runningBox', 'successBox', 'errorBox'];
// null/undefined hides every box — used when already connected and idle, so
// the "start new QR login" button does not show next to an account that is
// already logged in.
function showBox(name) { boxes.forEach((b) => { $(b).hidden = b !== name; }); }

// After a restart (QR success, logout, or a room-selection change that
// changed the talk/square surface) the worker process exits and comes back
// a few seconds later — supervised locally by start.bat's loop, by systemd
// in production. Without this, the page just sat on a static "restarting…"
// note forever, which reads as hung. Polls a cheap endpoint and reloads
// itself the moment the new process answers; gives up (silently — the note
// already told them a manual refresh works) after ~30s.
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

let poller = null;
function stopPolling() { if (poller) { clearInterval(poller); poller = null; } }

function syncBox(body) {
  const f = body.flow;
  if (f.status === 'idle') { showBox(body.botSession ? null : 'idleBox'); stopPolling(); return; }
  if (f.status === 'running') {
    showBox('runningBox');
    if (f.qrSvg) $('qrHolder').innerHTML = f.qrSvg;
    if (f.pin) { $('pinBox').hidden = false; $('pinValue').textContent = f.pin; }
    $('elapsed').textContent = typeof f.elapsedMs === 'number'
      ? 'ผ่านมา ' + Math.round(f.elapsedMs / 1000) + ' วินาที'
      : '';
    return;
  }
  if (f.status === 'success') { showBox('successBox'); stopPolling(); return; }
  if (f.status === 'error') { $('errorMsg').textContent = f.message; showBox('errorBox'); stopPolling(); }
}

async function pollFlow() {
  syncBox(await loadSessionInfo());
}

$('startBtn').addEventListener('click', async () => {
  const res = await fetch('/api/login/start', { method: 'POST' });
  if (!res.ok) { const b = await res.json(); await showAlert(b.error || 'เริ่มไม่สำเร็จ'); return; }
  showBox('runningBox');
  $('qrHolder').innerHTML = '';
  $('pinBox').hidden = true;
  poller = setInterval(pollFlow, 1500);
  pollFlow();
});

$('logoutBtn').addEventListener('click', async () => {
  if (!(await showConfirm('ออกจากระบบบัญชีนี้? ต้องสแกน QR ใหม่เพื่อกลับมาใช้งาน และ worker จะ restart ทันที'))) return;
  $('logoutBtn').disabled = true;
  $('logoutNote').textContent = 'กำลังออกจากระบบ…';
  try {
    const res = await fetch('/api/login/logout', { method: 'POST' });
    const body = await res.json();
    if (!res.ok) { $('logoutNote').textContent = body.error || 'ออกจากระบบไม่สำเร็จ'; $('logoutBtn').disabled = false; return; }
    $('logoutNote').textContent = 'ออกจากระบบแล้ว — กำลัง restart worker… หน้านี้จะรีโหลดให้อัตโนมัติ';
    waitForServerThenReload(20);
  } catch {
    $('logoutNote').textContent = 'ออกจากระบบไม่สำเร็จ — ติดต่อ worker ไม่ได้';
    $('logoutBtn').disabled = false;
  }
});

$('retryBtn').addEventListener('click', async () => {
  await fetch('/api/login/reset', { method: 'POST' });
  showBox('idleBox');
});

$('restartBtn').addEventListener('click', async () => {
  $('restartBtn').disabled = true;
  $('restartNote').textContent = 'กำลัง restart… หน้านี้จะรีโหลดให้อัตโนมัติ';
  await fetch('/api/admin/restart', { method: 'POST' }).catch(() => {});
  waitForServerThenReload(20);
});

loadSessionInfo().then((body) => {
  syncBox(body);
  if (body.flow.status !== 'idle') poller = setInterval(pollFlow, 1500);
});`,
});
