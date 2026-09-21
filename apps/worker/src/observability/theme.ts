/**
 * Shared shell for every page the worker serves itself: the dashboard, and
 * the admin pages (rules editor, login/re-auth). One palette, one set of
 * component styles, so a recolour or a spacing tweak is a single edit instead
 * of a hunt through every page (this is exactly why the dashboard recolour to
 * a light theme was a one-block change, and it stays that way as pages are
 * added).
 *
 * Deliberately an instrument panel, not a product page: monospace numerals,
 * colour used only to say "ok / needs attention / wrong", no cards-in-a-grid,
 * no gradient, no decoration that is not data (`CLAUDE .md` §7). Thai copy
 * sets line-height 1.7 and headroom above the line so tone marks are never
 * clipped (`CLAUDE .md` §8).
 */

export const THEME_HEAD = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans+Thai:wght@400;600&display=swap" rel="stylesheet">`;

export const THEME_STYLE = `
:root{
  color-scheme:light;
  --ink:#1c1917; --ink-dim:#57534e; --ink-faint:#a8a29e;
  --ground:#fafaf9; --raise:#f5f5f4; --rule:#e7e5e4;
  --ok:#15803d; --warn:#b45309; --bad:#b91c1c; --idle:#a8a29e;
  --mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  --thai:'IBM Plex Sans Thai',system-ui,sans-serif;
  --lh-thai:1.7; --gap-top-th:.5rem;
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--mono);
  font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:inherit}
.wrap{max-width:64rem;margin:0 auto;padding:1.5rem 1rem 4rem}
.th,.note{font-family:var(--thai);line-height:var(--lh-thai);padding-top:var(--gap-top-th)}

header{display:flex;flex-wrap:wrap;align-items:baseline;gap:.5rem 1rem;
  padding-bottom:1rem;border-bottom:1px solid var(--rule)}
h1{font-size:1rem;font-weight:600;margin:0;letter-spacing:.02em}
.worker{color:var(--ink-dim)}
.stamp{margin-left:auto;color:var(--ink-faint);font-size:12px;font-variant-numeric:tabular-nums}
nav{display:flex;gap:1rem;font-size:12px}
nav a{color:var(--ink-dim);text-decoration:none;border-bottom:1px solid transparent}
nav a:hover,nav a.on{color:var(--ink);border-color:var(--ink-faint)}

section{margin-top:2rem}
h2{font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;
  color:var(--ink-faint);margin:0 0 .75rem}

.state{display:inline-flex;align-items:center;gap:.5rem;font-size:1.5rem;font-weight:600}
.dot{width:.6rem;height:.6rem;border-radius:50%;background:var(--idle);flex:none}
.dot.ok{background:var(--ok);box-shadow:0 0 0 4px color-mix(in srgb,var(--ok) 22%,transparent)}
.dot.warn{background:var(--warn)} .dot.bad{background:var(--bad)}
.checks{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.75rem}
.chk{font-size:11px;padding:.25rem .5rem;border:1px solid var(--rule);border-radius:2px;
  color:var(--ink-faint)}
.chk.on{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 40%,var(--rule))}

table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{text-align:right;font-size:10px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--ink-faint);font-weight:400;padding:0 0 .5rem}
th:first-child,td:first-child{text-align:left}
td{padding:.55rem 0 .55rem .55rem;border-top:1px solid var(--rule);text-align:right;white-space:nowrap}
th{padding-left:.55rem}
td:first-child,th:first-child{padding-left:0}
tbody tr:hover{background:var(--raise)}

.badge{font-size:10px;letter-spacing:.08em;padding:.15rem .4rem;border-radius:2px;
  border:1px solid currentColor}
.b-hot{color:var(--ok)} .b-standby{color:var(--ink-dim)}
.b-wait{color:var(--warn)} .b-down{color:var(--bad)}
.v-ok{color:var(--ok)} .v-warn{color:var(--warn)} .v-bad{color:var(--bad)}
.dim{color:var(--ink-faint)}
.age{font-size:11px;color:var(--ink-faint)}

.bars{display:flex;flex-direction:column;gap:.6rem}
.bar{display:grid;grid-template-columns:6.5rem 1fr auto;align-items:center;gap:.75rem}
.bar .track{height:.5rem;background:var(--raise);border-radius:1px;overflow:hidden}
.bar .fill{height:100%;background:var(--ok)}
.bar .fill.warn{background:var(--warn)} .bar .fill.bad{background:var(--bad)}
.bar .num{font-size:12px;min-width:9rem;text-align:right}

.empty{color:var(--ink-faint);padding:.75rem 0}

/* --- latency breakdown panel --- */
.lb-head{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;margin-bottom:.75rem}
.lb-head h2{margin:0}
.lb-calls{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-faint);
  display:flex;flex-direction:column;align-items:flex-end;gap:.15rem}
.lb-calls b{font-size:1.1rem;font-weight:600;color:var(--ink);letter-spacing:0}

.lb-equation{display:flex;flex-wrap:wrap;align-items:baseline;gap:.6rem 1rem;
  padding-bottom:1rem;border-bottom:1px solid var(--rule)}
.lb-num{display:flex;flex-direction:column;gap:.2rem}
.lb-num b{font-size:1.6rem;font-weight:600;font-variant-numeric:tabular-nums}
.lb-num .dim{font-size:10px;letter-spacing:.06em;text-transform:uppercase}
.lb-op{align-self:center;color:var(--ink-faint);font-size:1.2rem;font-weight:600}

.lb-track{height:.4rem;background:var(--raise);border-radius:999px;overflow:hidden;margin:1rem 0}
.lb-fill{display:block;height:100%;border-radius:999px;background:var(--ok);transition:width .2s ease}
.lb-fill.warn{background:var(--warn)} .lb-fill.bad{background:var(--bad)}

.lb-roundtrip{padding:.75rem 0;border-bottom:1px solid var(--rule)}
.lb-rt-num{display:flex;align-items:baseline;gap:.6rem;font-size:1.3rem;font-weight:600;
  font-variant-numeric:tabular-nums}
.lb-rt-num .dim{font-size:10px;letter-spacing:.06em;text-transform:uppercase;font-weight:400}

.lb-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:.75rem;margin-top:1rem}
.lb-tile{border:1px solid var(--rule);border-radius:4px;padding:.6rem .75rem;
  display:flex;flex-direction:column;gap:.3rem}
.lb-tile-label{font-size:11px;color:var(--ink-dim)}
.lb-tile-val{font-size:1.15rem;font-weight:600;font-variant-numeric:tabular-nums}
.lb-tile-note{font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-faint)}
.lb-tile.line-trigger-reply{background:var(--ink);border-color:var(--ink);color:#fff}
.lb-tile.line-trigger-reply .lb-tile-label,
.lb-tile.line-trigger-reply .lb-tile-val,
.lb-tile.line-trigger-reply .lb-tile-note{color:#fff}

/* --- admin form controls (rules editor, login page) --- */
form{margin-top:1rem}
.field{margin-bottom:.75rem}
.field label{display:block;font-size:11px;letter-spacing:.06em;text-transform:uppercase;
  color:var(--ink-faint);margin-bottom:.3rem}
input[type=text],input[type=number],select,textarea{
  width:100%;font:inherit;font-size:13px;color:var(--ink);background:#fff;
  border:1px solid var(--rule);border-radius:3px;padding:.5rem .6rem}
input:focus,select:focus,textarea:focus{outline:2px solid var(--ink-faint);outline-offset:1px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}
.row3{display:grid;grid-template-columns:6rem 1fr 1fr;gap:.75rem}
button{font:inherit;font-size:13px;color:var(--ink);background:var(--raise);
  border:1px solid var(--rule);border-radius:3px;padding:.5rem .9rem;cursor:pointer}
button:hover{background:var(--rule)}
button.primary{color:#fff;background:var(--ink);border-color:var(--ink)}
button.primary:hover{background:#000}
button.danger{color:var(--bad);background:#fff;border-color:color-mix(in srgb,var(--bad) 35%,var(--rule))}
button.danger:hover{background:color-mix(in srgb,var(--bad) 8%,#fff)}
button:disabled{opacity:.5;cursor:default}
.actions{display:flex;gap:.5rem;margin-top:.5rem}
.msg{padding:.6rem .75rem;border-radius:3px;font-size:13px;margin:.75rem 0}
.msg.ok{background:color-mix(in srgb,var(--ok) 10%,#fff);color:var(--ok);
  border:1px solid color-mix(in srgb,var(--ok) 30%,var(--rule))}
.msg.bad{background:color-mix(in srgb,var(--bad) 8%,#fff);color:var(--bad);
  border:1px solid color-mix(in srgb,var(--bad) 30%,var(--rule))}
[hidden]{display:none!important}

.qr-wrap{display:flex;flex-direction:column;align-items:flex-start;gap:.75rem;margin-top:1rem}
/* The QR is inserted as a raw <svg> (server-rendered, no CDN script) with a
   viewBox but no width/height attribute — without an explicit size here a
   browser falls back to the generic replaced-element default (300x150),
   flattening a square code into a rectangle. img is styled too in case a
   future caller ever sets one via a data: URI instead. */
.qr-wrap img,.qr-wrap svg{display:block;width:220px;height:220px;background:#fff;
  border:1px solid var(--rule);border-radius:4px;padding:.5rem}
.pin{font-size:2rem;font-weight:600;letter-spacing:.1em}

/* In-page replacement for alert()/confirm()/prompt() — see showModal() in
   each page's own script. Shared here so every page's dialog looks and
   behaves the same, styled to match the rest of the shell instead of the
   browser's own chrome. */
.modal-overlay{position:fixed;inset:0;background:color-mix(in srgb,var(--ink) 45%,transparent);
  display:flex;align-items:center;justify-content:center;padding:1rem;z-index:1000}
.modal-box{background:#fff;border-radius:8px;padding:1.25rem;max-width:26rem;width:100%;
  box-shadow:0 10px 40px rgba(0,0,0,.25)}
.modal-msg{font-family:var(--thai);line-height:var(--lh-thai);margin:0 0 1rem;white-space:pre-wrap}
.modal-box input[type=text]{margin-bottom:1rem}
.modal-actions{display:flex;gap:.5rem;justify-content:flex-end}

@media (max-width:520px){
  .bar{grid-template-columns:5rem 1fr;row-gap:.25rem}
  .bar .num{grid-column:2;text-align:left;min-width:0}
  td,th{font-size:12px}
  .row,.row3{grid-template-columns:1fr}
  .lb-equation{flex-direction:column;align-items:flex-start}
  .lb-op{display:none}
}`;

/** Standard no-store, no-sniff headers for a page or JSON reply this worker
 * renders itself — a console must never show stale state (Playbook §13.3). */
export const NO_STORE_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

export interface PageOptions {
  title: string;
  /** Nav links shown in the header, current page marked with `active: true`. */
  nav: readonly { href: string; label: string; active?: boolean }[];
  bodyHtml: string;
  script: string;
}

/** Wraps one page's body + script in the shared shell. Every page gets the
 * same header/nav so moving between the dashboard and the admin pages is
 * obviously the same tool, not three unrelated ones bolted together. */
export function renderPage(opts: PageOptions): string {
  const navHtml = opts.nav
    .map((n) => `<a href="${n.href}"${n.active === true ? ' class="on"' : ''}>${n.label}</a>`)
    .join('');
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title}</title>
${THEME_HEAD}
<style>${THEME_STYLE}</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>line-first-response</h1>
    <span class="worker" id="worker">—</span>
    <nav>${navHtml}</nav>
    <span class="stamp" id="stamp"></span>
  </header>
${opts.bodyHtml}
</div>
<script>${opts.script}</script>
</body>
</html>`;
}
