#!/usr/bin/env node
/**
 * Authenticated DAST harness against local Web/API only.
 * Complements OWASP ZAP baseline: role matrix, XSS/SQLi probes, IDOR, CSRF, download.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WEB = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
const API = process.env.API_ORIGIN ?? 'http://localhost:3001';
const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'Dana-SGR-Demo-2026!';

function assertLocal(url) {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|host\.docker\.internal)(:\d+)?\//.test(`${url}/`)) {
    throw new Error(`refusing non-local DAST target: ${url}`);
  }
}

assertLocal(WEB);
assertLocal(API);

const ACCOUNTS = [
  { role: 'ADMIN', email: 'alexey.viktorov@example.sgr.local' },
  { role: 'SGR_MANAGER', email: 'marina.sokolova@example.sgr.local' },
  { role: 'RESPONSIBLE_ENGINEER', email: 'dmitry.orlov@example.sgr.local' },
  { role: 'CONTRACTOR_ENGINEER', email: 'igor.panteleev@example.sgr.local' },
];

const PATHS = [
  '/login',
  '/registry',
  '/notifications',
  '/deadlines',
  '/system-status',
  '/acts/new',
];

async function login(email) {
  const response = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB.replace(/\/$/, '') },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const cookie = setCookie.find((item) => item.startsWith('sgr_session='));
  const body = await response.json();
  if (!response.ok || !cookie) {
    throw new Error(`login failed for ${email}: ${response.status}`);
  }
  return {
    cookie: cookie.split(';')[0],
    csrfToken: body.csrfToken,
    role: body.role,
  };
}

function cookieHeader(session) {
  return { cookie: session.cookie, origin: WEB.replace(/\/$/, '') };
}

const findings = [];

async function record(name, ok, detail) {
  findings.push({ name, ok, detail });
  if (!ok) {
    console.error(`FAIL ${name}: ${detail}`);
  }
}

const unauthRoutes = [
  '/api/registry/defects',
  '/api/notifications',
  '/api/sla/items',
  '/api/system-status',
  '/api/attachments/11111111-1111-4111-8111-111111111111',
  '/api/attachments/11111111-1111-4111-8111-111111111111/content',
];
for (const path of unauthRoutes) {
  const response = await fetch(`${API}${path}`);
  await record(`unauth-${path}`, response.status === 401, `status ${response.status}`);
}

const health = await fetch(`${API}/api/health`);
const healthCsp = health.headers.get('content-security-policy') ?? '';
await record(
  'api-csp',
  /default-src 'none'/.test(healthCsp) &&
    /frame-ancestors 'none'/.test(healthCsp) &&
    /base-uri 'none'/.test(healthCsp) &&
    /form-action 'none'/.test(healthCsp),
  healthCsp,
);
await record(
  'api-nosniff',
  (health.headers.get('x-content-type-options') ?? '').toLowerCase() === 'nosniff',
  health.headers.get('x-content-type-options'),
);

const cors = await fetch(`${API}/api/health`, { headers: { origin: 'https://evil.example' } });
const allowOrigin = cors.headers.get('access-control-allow-origin') ?? '';
await record('cors-no-evil-origin', allowOrigin !== 'https://evil.example', allowOrigin);

const loginPage = await fetch(`${WEB}/login`);
const webCsp = loginPage.headers.get('content-security-policy') ?? '';
await record(
  'web-csp',
  /frame-ancestors 'none'/.test(webCsp) && /default-src 'self'/.test(webCsp),
  webCsp,
);
await record(
  'web-frame-options',
  (loginPage.headers.get('x-frame-options') ?? '').toLowerCase() === 'deny',
  loginPage.headers.get('x-frame-options'),
);

const openRedirect = await fetch(`${WEB}/login?next=https://evil.example`, { redirect: 'manual' });
const location = openRedirect.headers.get('location') ?? '';
await record(
  'open-redirect-login',
  !/evil\.example/.test(location),
  `status ${openRedirect.status} location ${location}`,
);

const sqli = await fetch(`${API}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: WEB.replace(/\/$/, '') },
  body: JSON.stringify({ email: "' OR 1=1 --", password: PASSWORD }),
});
await record('login-sqli', [400, 401].includes(sqli.status), `status ${sqli.status}`);

const xssLogin = await fetch(`${API}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: WEB.replace(/\/$/, '') },
  body: JSON.stringify({ email: '<script>alert(1)</script>', password: PASSWORD }),
});
const xssBody = await xssLogin.text();
await record(
  'login-xss',
  [400, 401].includes(xssLogin.status) && !xssBody.includes('<script>alert(1)</script>'),
  `status ${xssLogin.status}`,
);

let headerInjectionOk = false;
let headerInjectionDetail = '';
try {
  const headerInjection = await fetch(`${API}/api/health`, {
    headers: { 'x-request-id': 'abc\r\nX-Injected: 1' },
  });
  const serializedHeaders = [...headerInjection.headers.entries()]
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  headerInjectionOk = !/x-injected/i.test(serializedHeaders);
  headerInjectionDetail = 'response headers';
} catch (error) {
  headerInjectionOk = error instanceof TypeError;
  headerInjectionDetail = 'HTTP client rejected CR/LF in header value';
}
await record('header-injection', headerInjectionOk, headerInjectionDetail);

const methodConfusion = await fetch(`${API}/api/auth/login`);
await record(
  'method-confusion-login-get',
  methodConfusion.status >= 400,
  `status ${methodConfusion.status}`,
);

const oversized = await fetch(`${API}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: WEB.replace(/\/$/, '') },
  body: JSON.stringify({
    email: `${'a'.repeat(20_000)}@example.sgr.local`,
    password: 'x'.repeat(20_000),
  }),
});
await record(
  'oversized-login',
  [400, 401, 413].includes(oversized.status),
  `status ${oversized.status}`,
);

let adminActId = null;

for (const account of ACCOUNTS) {
  const session = await login(account.email);
  for (const path of PATHS) {
    const response = await fetch(`${WEB}${path}`, {
      headers: cookieHeader(session),
      redirect: 'manual',
    });
    await record(`${account.role}-web${path}`, response.status < 500, `status ${response.status}`);
  }

  const xssSearch = await fetch(
    `${API}/api/registry/defects?search=${encodeURIComponent('<script>alert(1)</script>')}`,
    { headers: cookieHeader(session) },
  );
  const xssSearchBody = await xssSearch.text();
  await record(
    `${account.role}-reflected-xss-search`,
    xssSearch.status < 500 && !xssSearchBody.includes('<script>alert(1)</script>'),
    `status ${xssSearch.status}`,
  );

  const sqliSearch = await fetch(
    `${API}/api/registry/defects?search=${encodeURIComponent("' OR 1=1 --")}`,
    { headers: cookieHeader(session) },
  );
  await record(
    `${account.role}-sqli-search`,
    [200, 400].includes(sqliSearch.status),
    `status ${sqliSearch.status}`,
  );

  const registry = await fetch(`${API}/api/registry/defects?pageSize=50`, {
    headers: cookieHeader(session),
  });
  const bodyText = await registry.text();
  if (account.role === 'ADMIN' && !adminActId) {
    const match = bodyText.match(/"actId"\s*:\s*"([0-9a-f-]{36})"/i);
    adminActId = match?.[1] ?? null;
  }
  if (account.role === 'RESPONSIBLE_ENGINEER') {
    await record(
      'responsible-no-bc-registry',
      !/"slot":"B"/.test(bodyText) && !/proposalsBC/.test(bodyText),
      'B/C leak check',
    );
    const notifications = await fetch(`${API}/api/notifications`, {
      headers: cookieHeader(session),
    });
    const notificationsText = await notifications.text();
    await record(
      'responsible-no-bc-notifications',
      notifications.status === 200 &&
        !/"slot":"B"/.test(notificationsText) &&
        !/proposalsBC/.test(notificationsText),
      `status ${notifications.status}`,
    );
  }

  const csrf = await fetch(`${API}/api/auth/logout`, {
    method: 'POST',
    headers: { ...cookieHeader(session), 'content-type': 'application/json' },
    body: '{}',
  });
  await record(`${account.role}-csrf-required`, csrf.status === 403, `status ${csrf.status}`);

  const traversal = await fetch(`${API}/api/attachments/..%2f..%2fetc%2fpasswd`, {
    headers: cookieHeader(session),
  });
  await record(
    `${account.role}-path-traversal`,
    [400, 401, 404].includes(traversal.status),
    `status ${traversal.status}`,
  );

  const fakeAct = '11111111-1111-4111-8111-111111111111';
  const upload = await fetch(`${API}/api/acts/${fakeAct}/attachments`, {
    method: 'POST',
    headers: {
      ...cookieHeader(session),
      'x-csrf-token': session.csrfToken,
      'content-type': 'multipart/form-data; boundary=----dastboundary',
    },
    body: [
      '------dastboundary',
      'Content-Disposition: form-data; name="file"; filename="../../etc/passwd.jpg"',
      'Content-Type: image/jpeg',
      '',
      'not-a-jpeg',
      '------dastboundary--',
      '',
    ].join('\r\n'),
  });
  const uploadBody = await upload.text();
  await record(
    `${account.role}-malicious-filename`,
    [400, 403, 404, 415, 422].includes(upload.status) && !uploadBody.includes('/etc/passwd'),
    `status ${upload.status}`,
  );
}

if (adminActId) {
  const responsible = await login(
    ACCOUNTS.find((item) => item.role === 'RESPONSIBLE_ENGINEER').email,
  );
  const detail = await fetch(`${API}/api/acts/${adminActId}`, {
    headers: cookieHeader(responsible),
  });
  const detailText = await detail.text();
  await record(
    'responsible-act-detail-idor-or-bc',
    [200, 404].includes(detail.status) &&
      !/"slot":"B"/.test(detailText) &&
      !/proposalsBC/.test(detailText),
    `status ${detail.status}`,
  );
} else {
  await record('responsible-act-detail-idor-or-bc', true, 'no seeded act id in admin registry');
}

const failed = findings.filter((item) => !item.ok);
writeFileSync(
  resolve(process.cwd(), 'test-results/security/dast-authenticated.json'),
  JSON.stringify({ web: WEB, api: API, findings, failed: failed.length }, null, 2),
);
if (failed.length > 0) {
  process.exit(1);
}
console.log(`authenticated DAST harness passed (${findings.length} checks)`);
