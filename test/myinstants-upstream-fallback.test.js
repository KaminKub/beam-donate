'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
const block = source.slice(source.indexOf('const myinstantsCache ='), source.indexOf("app.get('/api/myinstants/pages'"));
const validHtml = '<html>' + ' '.repeat(500) + "<button onclick=\"play('/media/sounds/example.mp3')\"></button></html>";
function harness(get, enabled = true) {
  let now = 1000000;
  let calls = 0;
  const routes = new Map();
  const logs = [];
  const auth = () => {};
  const limiter = () => {};
  const shed = () => {};
  const context = vm.createContext({ URL, Map, Date: class extends Date { static now() { return now; } },
    process: { env: enabled ? { MYINSTANTS_CATALOG_ENABLED: 'true' } : {} },
    console: { warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    axios: { get: async (...args) => { calls++; return get(...args); } },
    app: { get: (route, ...handlers) => routes.set(route, handlers) },
    ensureAuthenticated: auth, myinstantsLimiter: limiter, rateLimit: () => limiter, loadShedGuard: () => shed });
  vm.runInContext(block, context);
  return { context, routes, auth, limiter, shed, logs, calls: () => calls, advance: ms => { now += ms; },
    search: async (query = {}) => {
      const res = { statusCode: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; },
        status(n) { this.statusCode = n; return this; }, json(data) { this.body = JSON.parse(JSON.stringify(data)); return this; } };
      await context.handleMyinstantsSearch({ query }, res);
      return res;
    } };
}
test('default manual-only mode makes zero upstream requests and gives fallback', async () => {
  const h = harness(async () => { throw new Error('must not fetch'); }, false);
  const res = await h.search();
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'CATALOG_DISABLED');
  assert.equal(res.body.fallbackDirectUrl, 'https://www.myinstants.com/en/index/th/');
  assert.equal(res.headers['Retry-After'], undefined);
  assert.equal(h.calls(), 0);
});
test('200 results and explicit empty are successful; unknown HTML is unavailable', async () => {
  for (const [html, status, count] of [[validHtml, 200, 1], ['<html>' + ' '.repeat(500) + 'No sounds found</html>', 200, 0], ['<html>' + ' '.repeat(500) + 'Cloudflare challenge</html>', 503, 0]]) {
    const h = harness(async () => ({ status: 200, data: html }));
    const res = await h.search();
    assert.equal(res.statusCode, status);
    assert.equal(res.body.results.length, count);
    assert.equal(res.body.success, status === 200);
  }
});
for (const [status, code] of [[403, 'UPSTREAM_BLOCKED'], [429, 'UPSTREAM_RATE_LIMITED'], [503, 'UPSTREAM_UNAVAILABLE'], [302, 'UPSTREAM_UNAVAILABLE']]) {
  test(`${status}: safe contract, bounded cooldown across queries, recovery`, async () => {
    const h = harness(async (url, options) => {
      assert.equal(options.maxRedirects, 0);
      assert.equal(options.maxContentLength, 2097152);
      return h.calls() === 1 ? { status, data: 'SECRET Cloudflare HTML', headers: { 'retry-after': '9999999' } } : { status: 200, data: validHtml };
    });
    const first = await h.search({ q: '<private>' });
    assert.equal(first.statusCode, 503);
    assert.equal(first.body.code, code);
    assert.equal(first.body.retryAfterSeconds, 300);
    assert.equal(first.headers['Cache-Control'], 'no-store');
    assert.doesNotMatch(JSON.stringify(first.body), /SECRET|Cloudflare HTML/);
    assert.doesNotMatch(JSON.stringify(h.logs), /private|SECRET|Cloudflare HTML/);
    await h.search({ q: 'different' });
    assert.equal(h.calls(), 1);
    h.advance(300001);
    assert.equal((await h.search()).statusCode, 200);
    assert.equal(h.calls(), 2);
  });
}
for (const [error, code] of [['ECONNABORTED', 'UPSTREAM_TIMEOUT'], ['ETIMEDOUT', 'UPSTREAM_TIMEOUT'], ['ENOTFOUND', 'UPSTREAM_NETWORK_ERROR'], ['ECONNRESET', 'UPSTREAM_NETWORK_ERROR']]) {
  test(error, async () => {
    const h = harness(async () => { throw Object.assign(new Error('private raw detail'), { code: error }); });
    const res = await h.search();
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, code);
    assert.doesNotMatch(JSON.stringify([res.body, h.logs]), /private raw detail/);
  });
}
test('coalesces same query and bounds parallel different queries', async () => {
  let release;
  const h = harness(() => new Promise(resolve => { release = resolve; }));
  const first = h.search({ q: 'one' });
  const same = h.search({ q: 'one' });
  assert.equal((await h.search({ q: 'two' })).body.code, 'UPSTREAM_BUSY');
  assert.equal(h.calls(), 1);
  release({ status: 403 });
  assert.equal((await first).body.code, 'UPSTREAM_BLOCKED');
  assert.equal((await same).body.code, 'UPSTREAM_BLOCKED');
});
test('invalid inputs never reach upstream; guards and retired proxy remain', async () => {
  const h = harness(async () => { throw new Error('unexpected'); });
  for (const query of [{ q: [] }, { q: 'x'.repeat(201) }, { page: {} }, { page: 'bad' }, { offset: '-1' }, { limit: [] }]) {
    assert.equal((await h.search(query)).statusCode, 400);
  }
  assert.equal(h.calls(), 0);
  assert.equal(h.routes.get('/api/myinstants/search')[0], h.auth);
  assert.equal(h.routes.get('/api/myinstants/search')[1], h.limiter);
  assert.equal(h.routes.get('/api/public/myinstants/search')[0], h.shed);
  assert.equal(h.routes.get('/api/public/myinstants/search')[1], h.limiter);
  const proxy = h.routes.get('/api/myinstants/proxy');
  assert.equal(proxy[0], h.auth);
  const res = { set() {}, status(n) { this.code = n; return this; }, json(body) { this.body = body; } };
  await proxy.at(-1)({ query: { url: 'https://evil.example' } }, res);
  assert.equal(res.code, 410);
  assert.equal(h.calls(), 0);
});
test('cache stays bounded and expires', async () => {
  const h = harness(async () => ({ status: 200, data: validHtml }));
  for (let i = 0; i < 110; i++) await h.search({ q: String(i) });
  assert.equal(vm.runInContext('myinstantsCache.size', h.context), 100);
  await h.search({ q: '109' });
  assert.equal(h.calls(), 110);
  h.advance(600001);
  await h.search({ q: '109' });
  assert.equal(h.calls(), 111);
});
test('Retry-After HTTP dates produce bounded integer seconds', async () => {
  const h = harness(async () => ({ status: 429, headers: { 'retry-after': new Date(1060000).toUTCString() } }));
  h.advance(123);
  const res = await h.search();
  assert.equal(res.headers['Retry-After'], '60');
});
test('200 challenge and short/non-string bodies are invalid, never empty success', async () => {
  for (const data of ['', {}, '<html>short</html>', '<title>Just a moment...</title>' + validHtml]) {
    const h = harness(async () => ({ status: 200, data }));
    assert.equal((await h.search()).body.code, 'UPSTREAM_INVALID_HTML');
  }
});
test('Bot Fight Mode script inside a normal page is not treated as a challenge', async () => {
  // Cloudflare แทรกสคริปต์นี้ในหน้า 200 ปกติทุกหน้า ไม่ใช่เฉพาะหน้า challenge
  const data = validHtml.replace('<html>', "<html><script>var s=document.createElement('script');s.src='/cdn-cgi/challenge-platform/scripts/precursor/main.js';</script>");
  const h = harness(async () => ({ status: 200, data }));
  const res = await h.search();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.code, 'OK');
  assert.equal(res.body.results.length, 1);
});
test('provider cannot inject arbitrary audio hosts through primary parser', async () => {
  const data = '<html>' + ' '.repeat(500) + `<div class="instant"><button class="small-button" onclick="play('https://evil.example/a.mp3')" title="Play test sound"></button><a href="/x" class="instant-link">evil</a></div></html>`;
  const h = harness(async () => ({ status: 200, data }));
  const res = await h.search();
  assert.equal(res.body.code, 'UPSTREAM_INVALID_HTML');
  assert.doesNotMatch(JSON.stringify(res.body), /evil/);
});
