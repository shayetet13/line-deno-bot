import { renderPage } from '../observability/theme.ts';

/**
 * Admin-only management for human operator accounts. These accounts are
 * system-wide and deliberately independent from each bot's LINE login.
 */
export const USERS_HTML = renderPage({
  title: 'line-first-response · users',
  nav: [
    { href: '/', label: 'dashboard' },
    { href: '/groups', label: 'groups' },
    { href: '/rules', label: 'rules' },
    { href: '/login', label: 'LINE bot login' },
    { href: '/users', label: 'users', active: true },
    { href: '/account/logout', label: 'ออกจากระบบ' },
  ],
  bodyHtml: `
  <section>
    <h2>ผู้ใช้งาน</h2>
    <table>
      <thead><tr><th>ชื่อผู้ใช้</th><th>สิทธิ์</th><th>บอทของผู้ใช้</th><th></th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <p id="msg" class="msg" hidden></p>
  </section>

  <section>
    <h2>เพิ่มผู้ใช้ใหม่</h2>
    <p class="note">ผู้ใช้แต่ละคนมีบอทของตัวเอง (LINE, กฎ, ห้อง แยกกันหมด) — สร้างให้อัตโนมัติตอน login ครั้งแรก · สิทธิ์ <b>user</b> เข้าหน้า /app ได้อย่างเดียว ไม่เห็น dashboard/ผู้ใช้งาน</p>
    <form id="form">
      <div class="row">
        <div class="field"><label for="username">ชื่อผู้ใช้</label><input type="text" id="username" required></div>
        <div class="field"><label for="password">รหัสผ่าน (อย่างน้อย 6 ตัว)</label><input type="text" id="password" required></div>
      </div>
      <div class="field"><label for="role">สิทธิ์</label>
        <select id="role">
          <option value="user">user</option>
          <option value="admin">admin</option>
        </select>
      </div>
      <div class="actions"><button type="submit" class="primary">เพิ่มผู้ใช้</button></div>
    </form>
  </section>`,
  script: `
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

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
const showConfirm = (message, confirmLabel) => showModal(message, { confirmLabel: confirmLabel || 'ยืนยัน' });
const showPrompt = (message, defaultValue) => showModal(message, { prompt: true, defaultValue });

function showMsg(text, ok) {
  const m = $('msg');
  m.textContent = text;
  m.className = 'msg ' + (ok ? 'ok' : 'bad');
  m.hidden = false;
}

async function load() {
  const res = await fetch('/api/users', { cache: 'no-store' });
  const body = await res.json();
  const users = body.users || [];
  $('rows').innerHTML = users.length === 0 ? '<tr><td colspan="4" class="empty">ยังไม่มีผู้ใช้</td></tr>' :
    users.map((u) =>
      '<tr><td>' + esc(u.username) + '</td><td class="dim">' + esc(u.role) + '</td>' +
      '<td class="dim">' + (u.botId ? esc(u.botId) : 'ยังไม่ได้สร้าง (สร้างตอน login ครั้งแรก)') + '</td>' +
      '<td><div class="actions">' +
      '<button type="button" data-reset="' + esc(u.userId) + '">รีเซ็ตรหัสผ่าน</button>' +
      '<button type="button" class="danger" data-del="' + esc(u.userId) + '">ลบ</button>' +
      '</div></td></tr>').join('');
}

$('rows').addEventListener('click', async (e) => {
  const resetId = e.target.getAttribute('data-reset');
  const delId = e.target.getAttribute('data-del');
  if (resetId) {
    const password = await showPrompt('รหัสผ่านใหม่ (อย่างน้อย 6 ตัวอักษร):');
    if (!password) return;
    const res = await fetch('/api/users/' + encodeURIComponent(resetId), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const body = await res.json();
    if (!res.ok) { showMsg(body.error || 'เปลี่ยนรหัสผ่านไม่สำเร็จ', false); return; }
    showMsg('เปลี่ยนรหัสผ่านแล้ว', true);
  }
  if (delId) {
    if (!(await showConfirm('ลบผู้ใช้นี้?'))) return;
    const res = await fetch('/api/users/' + encodeURIComponent(delId), { method: 'DELETE' });
    const body = await res.json();
    if (!res.ok) { showMsg(body.error || 'ลบไม่สำเร็จ', false); return; }
    showMsg('ลบผู้ใช้แล้ว', true);
    load();
  }
});

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await fetch('/api/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: $('username').value,
      password: $('password').value,
      role: $('role').value,
    }),
  });
  const body = await res.json();
  if (!res.ok) { showMsg(body.error || 'เพิ่มผู้ใช้ไม่สำเร็จ', false); return; }
  showMsg('เพิ่มผู้ใช้ "' + body.user.username + '" แล้ว', true);
  $('form').reset();
  load();
});

load();`,
});
