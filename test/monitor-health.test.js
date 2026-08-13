'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { getConfig, monitorOnce } = require('../scripts/monitor-health');

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

async function withState(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'beam-donate-monitor-'));
  try {
    return await run(path.join(directory, 'state.json'));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function env() {
  return {
    HEALTHCHECK_URL: 'https://tipkub.example/health',
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/test/token',
    DISCORD_WATCHDOG_THREAD_ID: '123456789012345678',
    FAILURE_THRESHOLD: '2',
    HEALTHCHECK_TIMEOUT_MS: '1000',
    MONITOR_LABEL: 'test',
  };
}

test('healthy checks do not send Discord notifications', async () => {
  await withState(async (statePath) => {
    const calls = [];
    const result = await monitorOnce({
      env: env(),
      statePath,
      fetchImpl: async (url) => {
        calls.push(url);
        return url.includes('/health') ? response(200, { status: 'ok' }) : response(204, null);
      },
    });

    assert.equal(result.healthy, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], 'https://tipkub.example/health');
  });
});

test('failure threshold sends one down alert and recovery sends one message', async () => {
  await withState(async (statePath) => {
    let healthy = false;
    const discordMessages = [];
    const discordUrls = [];
    const fetchImpl = async (url, options) => {
      if (url.includes('/health')) return healthy ? response(200, { status: 'ok' }) : response(503, { error: 'unavailable' });
      discordUrls.push(url);
      discordMessages.push(JSON.parse(options.body).content);
      return response(204, null);
    };

    const first = await monitorOnce({ env: env(), statePath, fetchImpl });
    assert.equal(first.consecutiveFailures, 1);
    assert.equal(discordMessages.length, 0);

    const second = await monitorOnce({ env: env(), statePath, fetchImpl });
    assert.equal(second.status, 'down');
    assert.equal(discordMessages.length, 1);
    assert.equal(new URL(discordUrls[0]).searchParams.get('thread_id'), '123456789012345678');
    assert.equal(new URL(discordUrls[0]).searchParams.get('wait'), 'true');
    assert.match(discordMessages[0], /health alert/);

    await monitorOnce({ env: env(), statePath, fetchImpl });
    assert.equal(discordMessages.length, 1);

    healthy = true;
    const recovered = await monitorOnce({ env: env(), statePath, fetchImpl });
    assert.equal(recovered.status, 'up');
    assert.equal(discordMessages.length, 2);
    assert.match(discordMessages[1], /recovered/);
  });
});

test('Discord webhook must use an allowed HTTPS host', () => {
  assert.throws(
    () => getConfig({
      HEALTHCHECK_URL: 'https://tipkub.example/health',
      DISCORD_WEBHOOK_URL: 'https://evil.example/webhook',
      DISCORD_WATCHDOG_THREAD_ID: '123456789012345678',
    }),
    /allowed Discord webhook host/,
  );
});

test('Discord watchdog thread ID must be a snowflake', () => {
  assert.throws(
    () => getConfig({
      HEALTHCHECK_URL: 'https://tipkub.example/health',
      DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/test/token',
      DISCORD_WATCHDOG_THREAD_ID: 'not-a-thread-id',
    }),
    /Discord snowflake ID/,
  );
});
