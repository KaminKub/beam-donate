'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_FAILURE_THRESHOLD = 2;
const DEFAULT_STATE_FILE = '.uptime-monitor-state.json';
const DISCORD_HOSTS = new Set(['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com']);

class MonitorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MonitorError';
    this.code = code;
  }
}

function parsePositiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new MonitorError('INVALID_CONFIG', `${name} must be a positive integer`);
  }
  return parsed;
}

function parseHttpsUrl(value, name, allowedHosts) {
  if (!value) throw new MonitorError('INVALID_CONFIG', `${name} is required`);

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new MonitorError('INVALID_CONFIG', `${name} must be a valid URL`);
  }

  if (parsed.protocol !== 'https:') {
    throw new MonitorError('INVALID_CONFIG', `${name} must use HTTPS`);
  }
  if (allowedHosts && !allowedHosts.has(parsed.hostname.toLowerCase())) {
    throw new MonitorError('INVALID_CONFIG', `${name} is not an allowed Discord webhook host`);
  }

  return parsed.toString();
}

function parseDiscordSnowflake(value, name) {
  if (!value || !/^\d{16,22}$/.test(value)) {
    throw new MonitorError('INVALID_CONFIG', `${name} must be a Discord snowflake ID`);
  }
  return value;
}

function getConfig(env = process.env) {
  return {
    healthUrl: parseHttpsUrl(env.HEALTHCHECK_URL, 'HEALTHCHECK_URL'),
    discordWebhookUrl: parseHttpsUrl(env.DISCORD_WEBHOOK_URL, 'DISCORD_WEBHOOK_URL', DISCORD_HOSTS),
    discordThreadId: parseDiscordSnowflake(env.DISCORD_WATCHDOG_THREAD_ID, 'DISCORD_WATCHDOG_THREAD_ID'),
    timeoutMs: parsePositiveInteger(env.HEALTHCHECK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 'HEALTHCHECK_TIMEOUT_MS'),
    failureThreshold: parsePositiveInteger(env.FAILURE_THRESHOLD, DEFAULT_FAILURE_THRESHOLD, 'FAILURE_THRESHOLD'),
    statePath: env.MONITOR_STATE_FILE || DEFAULT_STATE_FILE,
    label: env.MONITOR_LABEL || 'TipKub production',
  };
}

function initialState() {
  return {
    status: 'up',
    consecutiveFailures: 0,
    lastTransitionAt: null,
  };
}

async function readState(statePath) {
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!['up', 'down'].includes(parsed.status)) return initialState();
    return {
      status: parsed.status,
      consecutiveFailures: Number.isInteger(parsed.consecutiveFailures) && parsed.consecutiveFailures >= 0
        ? parsed.consecutiveFailures
        : 0,
      lastTransitionAt: typeof parsed.lastTransitionAt === 'string' ? parsed.lastTransitionAt : null,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return initialState();
    // A corrupt or partially written state must not stop health monitoring.
    return initialState();
  }
}

async function writeState(statePath, state) {
  const parent = path.dirname(statePath);
  if (parent && parent !== '.') await fs.mkdir(parent, { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state)}\n`, 'utf8');
}

async function fetchWithTimeout(url, options, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') throw new MonitorError('REQUEST_TIMEOUT', 'request timed out');
    throw new MonitorError('REQUEST_FAILED', 'request failed');
  } finally {
    clearTimeout(timer);
  }
}

async function checkHealth(config, fetchImpl = globalThis.fetch) {
  let response;
  try {
    response = await fetchWithTimeout(config.healthUrl, { method: 'GET', headers: { accept: 'application/json' } }, config.timeoutMs, fetchImpl);
  } catch (error) {
    if (error instanceof MonitorError) throw error;
    throw new MonitorError('REQUEST_FAILED', 'request failed');
  }

  if (!response.ok) throw new MonitorError(`HTTP_${response.status}`, `health endpoint returned HTTP ${response.status}`);

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new MonitorError('INVALID_HEALTH_RESPONSE', 'health endpoint did not return JSON');
  }
  if (!payload || payload.status !== 'ok') {
    throw new MonitorError('UNHEALTHY_RESPONSE', 'health endpoint did not report ok');
  }
}

async function sendDiscord(config, content, fetchImpl = globalThis.fetch) {
  const discordUrl = new URL(config.discordWebhookUrl);
  discordUrl.searchParams.set('thread_id', config.discordThreadId);
  discordUrl.searchParams.set('wait', 'true');

  const response = await fetchWithTimeout(discordUrl.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  }, config.timeoutMs, fetchImpl);

  if (!response.ok) throw new MonitorError(`DISCORD_HTTP_${response.status}`, `Discord webhook returned HTTP ${response.status}`);
}

function messageFor(config, type, consecutiveFailures, now) {
  if (type === 'down') {
    return [
      '🚨 TipKub health alert',
      `ระบบ ${config.label} ไม่ตอบสนองตาม health check`,
      `ล้มเหลวต่อเนื่อง: ${consecutiveFailures} ครั้ง`,
      `เวลา: ${now}`,
    ].join('\n');
  }
  return [
    '✅ TipKub recovered',
    `ระบบ ${config.label} กลับมาตอบสนองแล้ว`,
    `เวลา: ${now}`,
  ].join('\n');
}

async function monitorOnce({ env = process.env, statePath, fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const config = getConfig({ ...env, ...(statePath ? { MONITOR_STATE_FILE: statePath } : {}) });
  const state = await readState(config.statePath);
  const timestamp = now().toISOString();

  try {
    await checkHealth(config, fetchImpl);

    if (state.status === 'down') {
      try {
        await sendDiscord(config, messageFor(config, 'recovery', 0, timestamp), fetchImpl);
      } catch (error) {
        await writeState(config.statePath, state);
        return { healthy: true, status: 'down', notificationError: error.code || 'DISCORD_SEND_FAILED' };
      }
      state.status = 'up';
      state.lastTransitionAt = timestamp;
    }

    state.consecutiveFailures = 0;
    await writeState(config.statePath, state);
    return { healthy: true, status: state.status, notificationSent: state.status === 'up' && state.lastTransitionAt === timestamp };
  } catch (error) {
    const failureCode = error.code || 'HEALTH_CHECK_FAILED';
    state.consecutiveFailures += 1;

    const shouldNotify = state.status !== 'down' && state.consecutiveFailures >= config.failureThreshold;
    if (shouldNotify) {
      try {
        await sendDiscord(config, messageFor(config, 'down', state.consecutiveFailures, timestamp), fetchImpl);
        state.status = 'down';
        state.lastTransitionAt = timestamp;
      } catch (notificationError) {
        await writeState(config.statePath, state);
        return {
          healthy: false,
          status: state.status,
          consecutiveFailures: state.consecutiveFailures,
          failureCode,
          notificationError: notificationError.code || 'DISCORD_SEND_FAILED',
        };
      }
    }

    await writeState(config.statePath, state);
    return {
      healthy: false,
      status: state.status,
      consecutiveFailures: state.consecutiveFailures,
      failureCode,
      notificationSent: shouldNotify,
    };
  }
}

async function main() {
  const result = await monitorOnce();
  if (result.notificationError) {
    console.error(`[uptime-monitor] ${result.notificationError}; notification state was not advanced`);
    process.exitCode = 1;
    return;
  }
  if (!result.healthy) {
    console.error(`[uptime-monitor] health check failed: ${result.failureCode} (${result.consecutiveFailures} consecutive)`);
    return;
  }
  console.log(`[uptime-monitor] health check ok (${result.status})`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[uptime-monitor] ${error.code || 'MONITOR_FAILED'}: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  getConfig,
  monitorOnce,
  readState,
};
