// Disposable environment: never loads the workspace .env or remote database.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
(async () => {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tipkub-http-'));
  const env = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP,
    PORT: String(port), NODE_ENV: 'test', SESSION_SECRET: 'disposable-http-test',
    MASTER_ENCRYPTION_KEY: 'disposable-test-key', ENCRYPTION_SALT: 'disposable-salt' };
  for (const provider of ['TWITCH', 'STREAMLABS']) {
    env[provider + '_CLIENT_ID'] = 'test';
    env[provider + '_CLIENT_SECRET'] = 'test';
    env[provider + '_CALLBACK_URL'] = 'http://127.0.0.1/callback';
  }
  const child = spawn(process.execPath, [path.resolve(__dirname, '../src/server.js')], { cwd, env, windowsHide: true });
  let output = '';
  const closed = new Promise(resolve => child.once('close', resolve));
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', data => { output += data; if (output.includes('Stream Donation server running')) resolve(); });
    child.stderr.on('data', data => { output += data; });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Startup exited ${code}: ${output}`)));
  });
  const timer = setTimeout(() => child.kill(), 15000);
  try {
    await ready;
    const base = `http://127.0.0.1:${port}`;
    const res = await fetch(base + '/api/public/myinstants/search?q=test');
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal((await res.json()).code, 'CATALOG_DISABLED');
    const auth = await fetch(base + '/api/myinstants/search', { redirect: 'manual' });
    assert.equal(auth.status, 401);
    const proxy = await fetch(base + '/api/myinstants/proxy', { redirect: 'manual' });
    assert.equal(proxy.status, 401);
    for (let i = 0; i < 9; i++) await fetch(base + '/api/public/myinstants/search');
    assert.equal((await fetch(base + '/api/public/myinstants/search')).status, 429);
    assert.equal((await fetch(base + '/health')).status, 200);
    assert.doesNotMatch(output, /Uncaught Exception|Unhandled Rejection/);
    console.log('PASS isolated startup + real HTTP: default fallback 503, no-store, auth 401, public limiter 429, health 200');
  } finally {
    clearTimeout(timer);
    child.kill();
    await closed;
    // Remove only this freshly-created empty disposable directory.
    fs.rmdirSync(cwd);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
