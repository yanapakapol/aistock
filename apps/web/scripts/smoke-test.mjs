// Smoke test for the deployed aistock app.
// Hits every important endpoint and validates the response.
// Usage:  node apps/web/scripts/smoke-test.mjs
//
// Optional env:
//   BASE_URL   — defaults to https://aistock-web-j1cz.vercel.app
//   TIMEOUT_MS — per-request timeout, default 30000
//
// Exit code: 0 if every check passes, 1 if any fail. Each check is run
// independently — a failure does NOT short-circuit the rest of the suite.

const BASE = (process.env.BASE_URL || 'https://aistock-web-j1cz.vercel.app').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 30000);

// ──────────────────────────────────────────────────────────────────────────
// Tiny ANSI color helpers. We don't pull in chalk to keep this single-file.
// TTY-only — if stdout is piped, we drop the codes so logs stay grep-able.
const isTTY = !!process.stdout.isTTY;
const c = (code, s) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => c('32', s);
const red = (s) => c('31', s);
const yellow = (s) => c('33', s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);

// ──────────────────────────────────────────────────────────────────────────
// Session cookie. Single string — the server sets multiple cookies (session +
// CSRF etc.); we replay them verbatim. `setCookie` parses a Set-Cookie list,
// strips attributes (Path, HttpOnly, Max-Age…) and joins name=value pairs.
let cookieJar = '';

function parseSetCookie(headerVal) {
  // fetch in undici exposes Set-Cookie as a single comma-joined string for
  // .get(), but we use .getSetCookie() (Node 18.14+) which returns an array.
  if (!headerVal || headerVal.length === 0) return [];
  return headerVal
    .map((line) => line.split(';')[0]) // name=value
    .filter(Boolean);
}

function mergeCookies(existing, incoming) {
  if (incoming.length === 0) return existing;
  const map = new Map();
  for (const pair of existing.split('; ').filter(Boolean)) {
    const eq = pair.indexOf('=');
    if (eq > 0) map.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  for (const pair of incoming) {
    const eq = pair.indexOf('=');
    if (eq > 0) map.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ──────────────────────────────────────────────────────────────────────────
async function request(method, path, { body, cookie, extraHeaders } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const headers = {
    accept: 'application/json, text/html;q=0.9, */*;q=0.5',
    ...(extraHeaders || {}),
  };
  const isMutating = method !== 'GET' && method !== 'HEAD';
  if (isMutating) headers['sec-fetch-site'] = 'same-origin';
  if (body !== undefined) headers['content-type'] = 'application/json';
  const ck = cookie !== undefined ? cookie : cookieJar;
  if (ck) headers['cookie'] = ck;

  const t0 = performance.now();
  let res, errMsg = null;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal: ctrl.signal,
    });
  } catch (err) {
    errMsg = err?.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : (err?.message || String(err));
  } finally {
    clearTimeout(timer);
  }
  const ms = Math.round(performance.now() - t0);
  if (errMsg) return { ok: false, ms, error: errMsg };

  const setCookies = parseSetCookie(res.headers.getSetCookie?.() ?? []);
  const ctype = res.headers.get('content-type') || '';
  let json = null, text = null;
  try {
    if (ctype.includes('application/json')) json = await res.json();
    else text = await res.text();
  } catch {
    // body parse failed — fall through with both null
  }
  return { ok: true, ms, status: res.status, headers: res.headers, json, text, setCookies };
}

// ──────────────────────────────────────────────────────────────────────────
const results = [];
function record(name, passed, ms, detail) {
  results.push({ name, passed, ms, detail });
  if (passed) {
    console.log(`${green('✓')} ${name} ${dim(`(${ms} ms)`)}`);
  } else {
    console.log(`${red('✗')} ${name} ${dim(`(${ms} ms)`)} — ${detail}`);
  }
}

// Wrap a check so a thrown exception inside doesn't kill the suite.
async function check(name, fn) {
  const t0 = performance.now();
  try {
    const r = await fn();
    const ms = Math.round(performance.now() - t0);
    if (r && r.passed) record(name, true, ms, '');
    else record(name, false, ms, (r && r.detail) || 'unknown failure');
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    record(name, false, ms, `threw: ${err?.message || err}`);
  }
}

const fiveXX = []; // collect any 5xx — these likely mean the cloud migration is incomplete

function noteServerError(name, res) {
  if (res.ok && res.status >= 500) fiveXX.push({ name, status: res.status });
}

// ──────────────────────────────────────────────────────────────────────────
console.log(bold(`Smoke test against ${BASE}`));
console.log(dim(`timeout per request: ${TIMEOUT_MS}ms`));
console.log('');

const startedAt = performance.now();
const guestUsername = `smoke_${Date.now()}`;
const guestPassword = 'smoke-test-pw-12345';
let guestUserId = null;

// ── 1. GET / ──────────────────────────────────────────────────────────────
await check('GET /  (home page reachable)', async () => {
  const r = await request('GET', '/');
  noteServerError('GET /', r);
  if (!r.ok) return { passed: false, detail: r.error };
  // 200 = home page rendered. 3xx -> /login is the app's auth gate for
  // unauthenticated visitors (see apps/web/middleware.ts) — also a healthy
  // response, just means the site is up and the middleware is wired.
  if (r.status === 200) return { passed: true };
  if (r.status >= 300 && r.status < 400) {
    const loc = r.headers.get('location') || '';
    if (loc.includes('/login')) return { passed: true };
    return { passed: false, detail: `got ${r.status} -> ${loc}, expected 200 or redirect to /login` };
  }
  return { passed: false, detail: `got ${r.status}, expected 200 or auth redirect` };
});

// ── 2. GET /api/auth/me (no cookie) ───────────────────────────────────────
await check('GET /api/auth/me  (no cookie -> user: null + totalUsers)', async () => {
  // Pass cookie:'' to force omission even if a previous check leaked one.
  const r = await request('GET', '/api/auth/me', { cookie: '' });
  noteServerError('GET /api/auth/me (anon)', r);
  if (!r.ok) return { passed: false, detail: r.error };
  if (r.status !== 200) return { passed: false, detail: `got ${r.status}, expected 200` };
  if (!r.json || typeof r.json !== 'object') return { passed: false, detail: 'no JSON body' };
  if (r.json.user !== null) return { passed: false, detail: `expected user:null, got ${JSON.stringify(r.json.user)}` };
  if (typeof r.json.totalUsers !== 'number') return { passed: false, detail: `expected numeric totalUsers, got ${typeof r.json.totalUsers}` };
  return { passed: true };
});

// ── 3. POST /api/auth/register-guest ──────────────────────────────────────
await check(`POST /api/auth/register-guest  (create ${guestUsername})`, async () => {
  const r = await request('POST', '/api/auth/register-guest', {
    body: { username: guestUsername, password: guestPassword },
    cookie: '',
  });
  noteServerError('POST /api/auth/register-guest', r);
  if (!r.ok) return { passed: false, detail: r.error };
  if (r.status !== 200) {
    return { passed: false, detail: `got ${r.status}, expected 200 — body: ${JSON.stringify(r.json ?? r.text)?.slice(0, 200)}` };
  }
  if (!r.json?.ok || r.json?.user?.role !== 'guest') {
    return { passed: false, detail: `expected {ok:true, user:{role:'guest'}}, got ${JSON.stringify(r.json)?.slice(0, 200)}` };
  }
  guestUserId = r.json.user.id;
  // Capture the session cookie for subsequent calls.
  cookieJar = mergeCookies(cookieJar, r.setCookies);
  if (!cookieJar.includes('aistock_session=')) {
    return { passed: false, detail: `no aistock_session cookie set; got: ${r.setCookies.join(', ') || '<none>'}` };
  }
  return { passed: true };
});

// ── 4. GET /api/auth/me with cookie ───────────────────────────────────────
await check('GET /api/auth/me  (with cookie -> guest user info)', async () => {
  const r = await request('GET', '/api/auth/me');
  noteServerError('GET /api/auth/me (auth)', r);
  if (!r.ok) return { passed: false, detail: r.error };
  if (r.status !== 200) return { passed: false, detail: `got ${r.status}, expected 200` };
  const u = r.json?.user;
  if (!u) return { passed: false, detail: `expected user object, got ${JSON.stringify(r.json)?.slice(0, 200)}` };
  if (u.role !== 'guest') return { passed: false, detail: `expected role:'guest', got '${u.role}'` };
  if (u.isAdmin !== false) return { passed: false, detail: `expected isAdmin:false, got ${u.isAdmin}` };
  return { passed: true };
});

// ── 5. GET /api/portfolio (fresh guest -> empty list) ─────────────────────
await check('GET /api/portfolio  (fresh guest -> stocks: [])', async () => {
  const r = await request('GET', '/api/portfolio');
  noteServerError('GET /api/portfolio (initial)', r);
  if (!r.ok) return { passed: false, detail: r.error };
  if (r.status !== 200) return { passed: false, detail: `got ${r.status}, expected 200` };
  if (!Array.isArray(r.json?.stocks)) {
    return { passed: false, detail: `expected {stocks: []}, got ${JSON.stringify(r.json)?.slice(0, 200)}` };
  }
  if (r.json.stocks.length !== 0) {
    return { passed: false, detail: `expected empty list for fresh guest, got ${r.json.stocks.length} stock(s)` };
  }
  return { passed: true };
});

// ── 6. POST /api/portfolio (add NVDA) ─────────────────────────────────────
let nvdaId = null;
await check('POST /api/portfolio  (add NVDA -> 201 created)', async () => {
  const r = await request('POST', '/api/portfolio', {
    body: { symbol: 'NVDA', exchange: 'NASDAQ', name: 'NVIDIA Corporation', currency: 'USD' },
  });
  noteServerError('POST /api/portfolio', r);
  if (!r.ok) return { passed: false, detail: r.error };
  if (r.status !== 201) {
    return { passed: false, detail: `got ${r.status}, expected 201 — body: ${JSON.stringify(r.json ?? r.text)?.slice(0, 200)}` };
  }
  if (r.json?.created !== true || r.json?.stock?.symbol !== 'NVDA' || typeof r.json?.stock?.id !== 'number') {
    return { passed: false, detail: `expected {created:true, stock:{id, symbol:'NVDA'}}, got ${JSON.stringify(r.json)?.slice(0, 200)}` };
  }
  nvdaId = r.json.stock.id;
  return { passed: true };
});

// ── 7. GET /api/portfolio (now contains NVDA) ─────────────────────────────
await check('GET /api/portfolio  (after add -> contains NVDA)', async () => {
  const r = await request('GET', '/api/portfolio');
  noteServerError('GET /api/portfolio (after add)', r);
  if (!r.ok) return { passed: false, detail: r.error };
  if (r.status !== 200) return { passed: false, detail: `got ${r.status}, expected 200` };
  const stocks = r.json?.stocks;
  if (!Array.isArray(stocks)) return { passed: false, detail: `expected {stocks: [...]}, got ${JSON.stringify(r.json)?.slice(0, 200)}` };
  if (!stocks.some((s) => s.symbol === 'NVDA')) {
    return { passed: false, detail: `expected NVDA in list, got: ${stocks.map((s) => s.symbol).join(', ') || '<empty>'}` };
  }
  return { passed: true };
});

// ── 8. GET /api/portfolio with garbage cookie -> 401 ──────────────────────
await check('GET /api/portfolio  (bad cookie -> 401)', async () => {
  const r = await request('GET', '/api/portfolio', {
    cookie: 'aistock_session=not.a.valid.token.at.all',
  });
  // The middleware lets the request through (cookie is present) and the route
  // handler's getCurrentUser() returns null -> 401. Anything else is a fail.
  if (!r.ok) return { passed: false, detail: r.error };
  if (r.status === 401) return { passed: true };
  // Some Vercel/middleware configs may 403 cross-origin or 429 rate-limit; we
  // only accept 401 here per the spec.
  return { passed: false, detail: `got ${r.status}, expected 401` };
});

// ── 9. GET /api/keys (guest inherits admin LLM keys) ──────────────────────
await check('GET /api/keys  (guest -> inherited admin keys list)', async () => {
  const r = await request('GET', '/api/keys');
  noteServerError('GET /api/keys', r);
  if (!r.ok) return { passed: false, detail: r.error };
  if (r.status !== 200) return { passed: false, detail: `got ${r.status}, expected 200` };
  // Shape: { llm: string[], news: string[], llmDetails: [{provider, inherited}] }
  if (!Array.isArray(r.json?.llm) || !Array.isArray(r.json?.news) || !Array.isArray(r.json?.llmDetails)) {
    return { passed: false, detail: `expected {llm, news, llmDetails} arrays, got ${JSON.stringify(r.json)?.slice(0, 200)}` };
  }
  // Don't require keys to be present (admin might not have configured any in
  // this deployment) — the contract we're testing is "endpoint responds with
  // the inherited-keys shape for a guest", not "admin has keys".
  return { passed: true };
});

// ── 10. POST /api/auth/login with bad creds -> 401 ───────────────────────
await check('POST /api/auth/login  (bad creds -> 401)', async () => {
  const r = await request('POST', '/api/auth/login', {
    body: { username: guestUsername, password: 'definitely-wrong-password' },
    cookie: '', // login should work without a prior session
  });
  noteServerError('POST /api/auth/login (bad)', r);
  if (!r.ok) return { passed: false, detail: r.error };
  return r.status === 401
    ? { passed: true }
    : { passed: false, detail: `got ${r.status}, expected 401` };
});

// ── 11. POST /api/auth/login with guest creds -> 200 + new cookie ────────
await check('POST /api/auth/login  (correct creds -> 200 + new cookie)', async () => {
  const r = await request('POST', '/api/auth/login', {
    body: { username: guestUsername, password: guestPassword },
    cookie: '',
  });
  noteServerError('POST /api/auth/login (good)', r);
  if (!r.ok) return { passed: false, detail: r.error };
  if (r.status !== 200) return { passed: false, detail: `got ${r.status}, expected 200 — body: ${JSON.stringify(r.json ?? r.text)?.slice(0, 200)}` };
  if (!r.setCookies.some((p) => p.startsWith('aistock_session='))) {
    return { passed: false, detail: `expected Set-Cookie: aistock_session=...; got: ${r.setCookies.join(', ') || '<none>'}` };
  }
  // Roll the cookie forward — every subsequent check uses the freshly-issued one.
  cookieJar = mergeCookies(cookieJar, r.setCookies);
  return { passed: true };
});

// ── 12. GET /api/models  (verify all 6 providers respond) ────────────────
await check('GET /api/models  (6 providers all return 200)', async () => {
  const providers = ['openai', 'anthropic', 'google', 'mistral', 'moonshot', 'deepseek'];
  const responses = await Promise.all(
    providers.map((p) => request('GET', `/api/models?provider=${p}`)),
  );
  const failures = [];
  responses.forEach((r, i) => {
    noteServerError(`GET /api/models?provider=${providers[i]}`, r);
    if (!r.ok) failures.push(`${providers[i]}: ${r.error}`);
    else if (r.status !== 200) failures.push(`${providers[i]}: ${r.status}`);
    else if (!Array.isArray(r.json?.models)) failures.push(`${providers[i]}: missing models[]`);
  });
  if (failures.length > 0) {
    return { passed: false, detail: `failed providers: ${failures.join('; ')}` };
  }
  return { passed: true };
});

// ── 13. GET /api/cron/tick (no auth) -> 401 or 503; 404 = skip ───────────
await check('GET /api/cron/tick  (no auth -> 401 if endpoint exists)', async () => {
  // The middleware short-circuits unauthenticated requests to /api/* with
  // its own 401 (no aistock_session cookie). To actually exercise the
  // route's bearer check we send our guest session cookie — the route then
  // 401s on the missing Authorization header (or 503s if CRON_SECRET is
  // unset in prod).
  const r = await request('GET', '/api/cron/tick');
  if (!r.ok) return { passed: false, detail: r.error };
  if (r.status === 404) {
    console.log(`  ${yellow('↳')} ${dim('endpoint absent (404) — skipped per spec')}`);
    return { passed: true };
  }
  if (r.status === 401) return { passed: true };
  if (r.status === 503) {
    // 503 = CRON_SECRET not configured. Treat as a soft-pass (the auth
    // mechanism is correct: it fails-closed) but flag it.
    console.log(`  ${yellow('↳')} ${dim('503 cron not configured — CRON_SECRET unset in deploy')}`);
    return { passed: true };
  }
  return { passed: false, detail: `got ${r.status}, expected 401 (or 503 if CRON_SECRET unset, or 404 if missing)` };
});

// ── 14. POST /api/auth/logout -> 200 ─────────────────────────────────────
await check('POST /api/auth/logout  (with cookie -> 200)', async () => {
  const r = await request('POST', '/api/auth/logout');
  noteServerError('POST /api/auth/logout', r);
  if (!r.ok) return { passed: false, detail: r.error };
  if (r.status !== 200) return { passed: false, detail: `got ${r.status}, expected 200` };
  // Apply Set-Cookie (server clears aistock_session by sending Max-Age=0;
  // mergeCookies treats it as a normal name=value pair, which is fine
  // because the *next* request to /api/auth/me passes cookie:'' anyway).
  cookieJar = mergeCookies(cookieJar, r.setCookies);
  return { passed: true };
});

// ── 15. GET /api/auth/me after logout -> user:null ───────────────────────
await check('GET /api/auth/me  (post-logout -> user: null)', async () => {
  // Use whatever the server left in cookieJar — logout should have cleared
  // the session cookie. Don't force cookie:'' so we actually verify the
  // server-issued clear took effect.
  const r = await request('GET', '/api/auth/me');
  noteServerError('GET /api/auth/me (post-logout)', r);
  if (!r.ok) return { passed: false, detail: r.error };
  if (r.status !== 200) return { passed: false, detail: `got ${r.status}, expected 200` };
  if (r.json?.user !== null) {
    return { passed: false, detail: `expected user:null after logout, got ${JSON.stringify(r.json?.user)?.slice(0, 200)}` };
  }
  return { passed: true };
});

// ──────────────────────────────────────────────────────────────────────────
// Summary
const totalMs = Math.round(performance.now() - startedAt);
const passed = results.filter((r) => r.passed).length;
const failed = results.length - passed;

console.log('');
console.log(bold('─── Summary ────────────────────────────────────────────────'));
console.log(`  ${green(`${passed} passed`)}   ${failed ? red(`${failed} failed`) : dim('0 failed')}   ${dim(`${totalMs} ms total`)}`);
if (guestUserId != null) console.log(dim(`  created guest user id=${guestUserId} username=${guestUsername}`));
if (nvdaId != null) console.log(dim(`  added stock id=${nvdaId} (NVDA)`));

if (fiveXX.length > 0) {
  console.log('');
  console.log(yellow(bold('5xx server errors (cloud migration may be incomplete):')));
  for (const e of fiveXX) console.log(`  - ${e.name}: ${e.status}`);
}

if (failed > 0) {
  console.log('');
  console.log(bold('Failed checks:'));
  for (const r of results.filter((x) => !x.passed)) {
    console.log(`  ${red('✗')} ${r.name} — ${r.detail}`);
  }
}

process.exit(failed === 0 ? 0 : 1);
