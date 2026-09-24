import { test } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { APP_HTML } from '../../src/admin/app-page.ts';

// `script` in app-page.ts is a template literal, so any *unescaped*
// backslash sequence meant for the browser's JS (e.g. writing '\n' instead
// of '\\n') gets collapsed by the outer literal before it ever reaches the
// page — producing a client-side SyntaxError with no server-side signal.
// `deno check`/lint can't catch this: the script is just an opaque string
// to the TypeScript compiler. Parsing the served script here is the only
// thing that would have caught the "unexpected token" bug this regresses.
test('the rendered /app script is syntactically valid JavaScript', () => {
  const match = APP_HTML.match(/<script>([\s\S]*)<\/script>/);
  expect(match).not.toBeNull();
  const script = match![1];
  expect(() => new Function(script)).not.toThrow();
});
