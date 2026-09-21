import { renderPage } from '../observability/theme.ts';

/**
 * Username/password login for the human operator — replaces relying
 * on whatever sits in front of the process (nginx basic auth, per the old
 * `admin/server.ts` docstring) with a system-wide human account system.
 */
export const ACCOUNT_LOGIN_HTML = renderPage({
  title: 'line-first-response · login',
  nav: [],
  bodyHtml: `
  <style>
    .wrap{max-width:26rem}
    .login-card{margin-top:3rem}
    .login-card button.primary{width:100%;padding:.75rem;font-size:15px}
    .login-card input{font-size:16px;padding:.75rem .6rem}
  </style>
  <section class="login-card">
    <h2>เข้าสู่ระบบ</h2>
    <form id="form">
      <div class="field"><label for="username">ชื่อผู้ใช้</label>
        <input type="text" id="username" autocomplete="username" required autofocus></div>
      <div class="field"><label for="password">รหัสผ่าน</label>
        <input type="password" id="password" autocomplete="current-password" required></div>
      <div class="actions">
        <button type="submit" class="primary" id="submitBtn">เข้าสู่ระบบ</button>
      </div>
    </form>
    <p id="msg" class="msg" hidden></p>
  </section>`,
  script: `
const $ = (id) => document.getElementById(id);

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('submitBtn').disabled = true;
  try {
    const res = await fetch('/api/account/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: $('username').value, password: $('password').value }),
    });
    const body = await res.json();
    if (!res.ok) {
      $('msg').textContent = body.error || 'เข้าสู่ระบบไม่สำเร็จ';
      $('msg').className = 'msg bad';
      $('msg').hidden = false;
      $('submitBtn').disabled = false;
      return;
    }
    location.href = body.role === 'admin' ? '/' : '/app';
  } catch {
    $('msg').textContent = 'เชื่อมต่อไม่สำเร็จ';
    $('msg').className = 'msg bad';
    $('msg').hidden = false;
    $('submitBtn').disabled = false;
  }
});`,
});
