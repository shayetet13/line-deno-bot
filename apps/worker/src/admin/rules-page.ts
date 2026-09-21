import { renderPage } from '../observability/theme.ts';

/**
 * The rule editor. Every write here goes through the same validator the
 * worker uses at startup and is applied to the live pipeline immediately —
 * no restart, because a keyword bot that stops answering for the seconds a
 * restart takes is exactly the failure this whole project exists to avoid.
 */
export const RULES_HTML = renderPage({
  title: 'line-first-response · rules',
  nav: [
    { href: '/', label: 'dashboard' },
    { href: '/groups', label: 'groups' },
    { href: '/rules', label: 'rules', active: true },
    { href: '/login', label: 'LINE bot login' },
    { href: '/users', label: 'users' },
    { href: '/account/logout', label: 'ออกจากระบบ' },
  ],
  bodyHtml: `
  <section>
    <h2>กฎที่ใช้อยู่</h2>
    <table>
      <thead><tr><th>id</th><th>priority</th><th>kind</th><th>pattern</th><th>reply</th><th></th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <p class="note">แก้แล้ว apply ทันทีกับ pipeline ที่กำลังรับงานจริง — ไม่ restart worker เลขคีย์เดิมชนกัน priority
      สูงกว่าชนะ (ตัวเลขมากกว่า = สำคัญกว่า)</p>
    <p id="msg" class="msg" hidden></p>
  </section>

  <section>
    <h2 id="formTitle">เพิ่มกฎใหม่</h2>
    <form id="form">
      <input type="hidden" id="editingId" value="">
      <div class="row3">
        <div class="field"><label for="id">id</label><input type="text" id="id" required></div>
        <div class="field"><label for="priority">priority</label><input type="number" id="priority" value="0" required></div>
        <div class="field"><label for="kind">kind</label>
          <select id="kind">
            <option value="exact">exact</option>
            <option value="prefix">prefix</option>
            <option value="contains">contains</option>
          </select>
        </div>
      </div>
      <div class="field"><label for="pattern">pattern (ข้อความที่ต้องตรง)</label>
        <input type="text" id="pattern" required></div>
      <div class="field"><label for="reply">reply (ข้อความตอบกลับ)</label>
        <textarea id="reply" rows="2" required></textarea></div>
      <div class="actions">
        <button type="submit" class="primary" id="submitBtn">เพิ่มกฎ</button>
        <button type="button" id="cancelBtn" hidden>ยกเลิกแก้ไข</button>
      </div>
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

function showMsg(text, ok) {
  const m = $('msg');
  m.textContent = text;
  m.className = 'msg ' + (ok ? 'ok' : 'bad');
  m.hidden = false;
}

function renderRows(rules) {
  $('rows').innerHTML = rules.length === 0
    ? '<tr><td colspan="6" class="empty">ยังไม่มีกฎ</td></tr>'
    : rules.slice().sort((a, b) => b.priority - a.priority).map((r) =>
        '<tr><td>' + esc(r.id) + '</td><td>' + r.priority + '</td><td class="dim">' + r.kind +
        '</td><td>' + esc(r.pattern) + '</td><td class="th">' + esc(r.reply) + '</td>' +
        '<td><div class="actions">' +
        '<button type="button" data-edit="' + esc(r.id) + '">แก้</button>' +
        '<button type="button" class="danger" data-del="' + esc(r.id) + '">ลบ</button>' +
        '</div></td></tr>').join('');
}

let currentRules = [];

async function load() {
  const res = await fetch('/api/rules', { cache: 'no-store' });
  const body = await res.json();
  currentRules = body.rules ?? [];
  renderRows(currentRules);
}

function startEdit(rule) {
  $('editingId').value = rule.id;
  $('id').value = rule.id;
  $('id').disabled = true;
  $('priority').value = rule.priority;
  $('kind').value = rule.kind;
  $('pattern').value = rule.pattern;
  $('reply').value = rule.reply;
  $('formTitle').textContent = 'แก้กฎ "' + rule.id + '"';
  $('submitBtn').textContent = 'บันทึกการแก้ไข';
  $('cancelBtn').hidden = false;
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
}

function stopEdit() {
  $('form').reset();
  $('editingId').value = '';
  $('id').disabled = false;
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
    if (!(await showConfirm('ลบกฎ "' + delId + '" ?'))) return;
    const res = await fetch('/api/rules/' + encodeURIComponent(delId), { method: 'DELETE' });
    const body = await res.json();
    if (!res.ok) { showMsg(body.error || 'ลบไม่สำเร็จ', false); return; }
    showMsg('ลบกฎ "' + delId + '" แล้ว', true);
    if ($('editingId').value === delId) stopEdit();
    load();
  }
});

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const editingId = $('editingId').value;
  const payload = {
    id: $('id').value.trim(),
    priority: Number($('priority').value),
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
  if (!res.ok) { showMsg(body.error || 'บันทึกไม่สำเร็จ', false); return; }
  showMsg(editingId ? 'แก้กฎ "' + payload.id + '" แล้ว — apply กับ worker ทันที' :
    'เพิ่มกฎ "' + payload.id + '" แล้ว — apply กับ worker ทันที', true);
  stopEdit();
  load();
});

load();`,
});
