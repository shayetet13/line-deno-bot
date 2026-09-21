import { renderPage } from '../observability/theme.ts';

export const GROUPS_HTML = renderPage({
  title: 'line-first-response · groups',
  nav: [
    { href: '/', label: 'dashboard' },
    { href: '/groups', label: 'groups', active: true },
    { href: '/rules', label: 'rules' },
    { href: '/login', label: 'LINE bot login' },
    { href: '/users', label: 'users' },
    { href: '/account/logout', label: 'ออกจากระบบ' },
  ],
  bodyHtml: `
  <section>
    <h2>เลือกห้องที่บอตจะทำงาน</h2>
    <p class="note">รวม LINE OA, OpenChat และกลุ่ม Talk ที่บัญชีนี้เข้าร่วม การบันทึกจะให้บอตรับ–ตอบเฉพาะรายการที่เลือกทันที โดยไม่ตัดการเชื่อมต่อ
      (ยกเว้นเปลี่ยนประเภทห้องที่รับ เช่น จากมีแต่ OpenChat เป็นมี Talk ด้วย ซึ่งต้อง restart หนึ่งครั้ง); เฉพาะ OpenChat เท่านั้นที่ LINE รองรับ fast poll</p>
    <form id="form">
      <div id="groups"><span class="dim">กำลังโหลดกลุ่ม…</span></div>
      <div class="actions">
        <button type="button" id="refresh">รีเฟรชรายการ</button>
        <button type="submit" class="primary" id="save" disabled>บันทึกกลุ่ม</button>
      </div>
    </form>
    <p id="msg" class="msg" hidden></p>
  </section>`,
  script: `
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let pollLimit = 0;

function message(text, ok) {
  const node = $('msg');
  node.textContent = text;
  node.className = 'msg ' + (ok ? 'ok' : 'bad');
  node.hidden = false;
}

// A surface change (e.g. adding a Talk room to an OpenChat-only bot) still
// restarts the worker. Without this the page just sat on a static
// "restarting…" message forever, which reads as hung — poll a cheap
// endpoint and reload once the new process answers.
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

async function load() {
  $('refresh').disabled = true;
  try {
    const res = await fetch('/api/groups?refresh=' + Date.now(), { cache: 'no-store' });
    const body = await res.json();
    if (!res.ok) {
      $('groups').innerHTML = '<span class="bad">' + esc(body.error || 'โหลดกลุ่มไม่สำเร็จ') + '</span>';
      return;
    }
    pollLimit = body.pollLimit || 0;
    const groups = body.groups || [];
    const labels = { oa: 'LINE OA', openchat: 'OpenChat', talk: 'Talk' };
    const order = ['oa', 'openchat', 'talk'];
    $('groups').innerHTML = groups.length === 0
      ? '<p class="empty">LINE ยังไม่ส่งรายชื่อห้องกลับมา</p>'
      : order.map((kind) => {
        const rows = groups.filter((g) => g.kind === kind);
        return '<h3>' + labels[kind] + ' <span class="dim">(' + rows.length + ')</span></h3>' +
          (rows.length === 0 ? '<p class="dim">ไม่มีรายการ</p>' :
          '<table><thead><tr><th>เลือก</th><th>ชื่อ</th><th>เส้นทางรับ</th><th>รหัส</th></tr></thead><tbody>' +
          rows.map((g) => '<tr><td><input type="checkbox" data-room="' + esc(g.id) + '" ' +
            (g.selected ? 'checked' : '') + '></td><td class="th">' + esc(g.name) +
            '</td><td>' + (kind === 'openchat' ? (g.fastPoll ? 'FAST POLL' : 'PUSH → FAST POLL เมื่อเลือก') : 'PUSH') +
            '</td><td class="dim">' + esc(g.id) + '</td></tr>').join('') + '</tbody></table>');
      }).join('');
    $('save').disabled = !body.connected || groups.length === 0;
    if (!body.connected) message('ยังไม่เชื่อมต่อ LINE จึงดูรายชื่อและเปลี่ยนกลุ่มไม่ได้', false);
    else if (body.warnings && body.warnings.length) message('บางประเภทโหลดไม่สำเร็จ: ' + body.warnings.join(' | '), false);
    else if (body.selectionMode === 'all') message('ตอนนี้บอตยังรับทุกห้อง เลือกรายการแล้วกดบันทึกเพื่อจำกัดห้อง', true);
  } catch (err) {
    $('groups').innerHTML = '<span class="bad">โหลดกลุ่มไม่สำเร็จ</span>';
    message(err instanceof Error ? err.message : 'โหลดกลุ่มไม่สำเร็จ', false);
  } finally {
    $('refresh').disabled = false;
  }
}

$('refresh').addEventListener('click', () => {
  $('groups').innerHTML = '<span class="dim">กำลังรีเฟรชรายการจาก LINE…</span>';
  void load();
});

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const roomIds = Array.from(document.querySelectorAll('[data-room]:checked')).map((node) => node.getAttribute('data-room'));
  if (roomIds.length === 0) {
    message('ต้องเลือกอย่างน้อย 1 รายการ', false);
    return;
  }
  $('save').disabled = true;
  const res = await fetch('/api/groups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomIds }),
  });
  const body = await res.json();
  if (!res.ok) {
    message(body.error || 'บันทึกไม่สำเร็จ', false);
    $('save').disabled = false;
    return;
  }
  if (!body.changed) {
    message('รายการที่เลือกไม่มีการเปลี่ยนแปลง', true);
  } else if (body.restarted) {
    message(
      'บันทึกแล้ว กำลัง restart worker… หน้านี้จะรีโหลดให้อัตโนมัติ (OpenChat fast poll สูงสุด ' + pollLimit +
        ' ห้อง)',
      true,
    );
    waitForServerThenReload(20);
  } else {
    message('บันทึกแล้ว และใช้งานทันทีโดยไม่ตัดการเชื่อมต่อ (OpenChat fast poll สูงสุด ' + pollLimit + ' ห้อง)', true);
  }
});

load();`,
});
