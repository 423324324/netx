#!/usr/bin/env node
/**
 * netx - know the speed before you wait for it.
 *
 *   netx probe [npm|pypi|github|all]   rank mirrors by TTFB + real throughput
 *   netx eta <url>                     measure, then predict total time
 *   netx get <url> -o <file>           download with progress, ETA, stall recovery
 *   netx fix                           print the fastest-mirror config commands
 *
 * Zero dependencies. Node >= 18 (global fetch + web streams).
 * MIT.
 */

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const VERSION = '0.1.0';
const UA = `netx/${VERSION} (+https://www.npmjs.com/package/netx-probe)`;

/* ------------------------------------------------------------------ config */

// GitHub is probed with a real tarball, because that is how repos are actually fetched.
// A timeout that still delivered bytes is reported as SLOW, never as dead.
const ENDPOINTS = {
  npm: [
    { name: 'npmjs',       url: 'https://registry.npmjs.org/express' },
    { name: 'npmmirror',   url: 'https://registry.npmmirror.com/express' },
    { name: 'tencent',     url: 'https://mirrors.cloud.tencent.com/npm/express' },
    { name: 'huaweicloud', url: 'https://repo.huaweicloud.com/repository/npm/express' },
  ],
  pypi: [
    { name: 'pypi',        url: 'https://pypi.org/simple/requests/' },
    { name: 'aliyun',      url: 'https://mirrors.aliyun.com/pypi/simple/requests/' },
    { name: 'tuna',        url: 'https://pypi.tuna.tsinghua.edu.cn/simple/requests/' },
    { name: 'huaweicloud', url: 'https://repo.huaweicloud.com/repository/pypi/simple/requests/' },
  ],
  github: [
    { name: 'codeload',     url: 'https://codeload.github.com/nodejs/node/tar.gz/refs/tags/v20.0.0', maxMs: 15000 },
    { name: 'github.git',   url: 'https://github.com/nodejs/node', maxMs: 6000 },
    { name: 'ghfast.top',   url: 'https://ghfast.top/https://codeload.github.com/nodejs/node/tar.gz/refs/tags/v20.0.0', maxMs: 15000 },
    { name: 'gh-proxy.com', url: 'https://gh-proxy.com/https://codeload.github.com/nodejs/node/tar.gz/refs/tags/v20.0.0', maxMs: 15000 },
  ],
};

/** Advisory: how to configure each ecosystem to use the winning mirror. */
const FIX_HINTS = {
  npm: m => [
    `npm config set registry ${m}`,
    `pnpm config set registry ${m}`,
    `yarn config set registry ${m}`,
  ],
  pypi: m => [
    `pip config set global.index-url ${m}`,
    `pip config set install.trusted-host ${new URL(m).host}`,
    `setx UV_DEFAULT_INDEX ${m}`,
  ],
  github: () => [
    '# GitHub direct is dead on many CN networks. Prefer tarballs over git clone:',
    '#   curl -L https://codeload.github.com/<owner>/<repo>/tar.gz/refs/heads/main -o repo.tar.gz',
    '# Or prefix raw/release URLs with a live proxy:',
    '#   https://gh-proxy.com/https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<file>',
  ],
};

const REGISTRY = {
  npm: {
    npmjs: 'https://registry.npmjs.org/',
    npmmirror: 'https://registry.npmmirror.com',
    tencent: 'https://mirrors.cloud.tencent.com/npm/',
    huaweicloud: 'https://repo.huaweicloud.com/repository/npm/',
  },
  pypi: {
    pypi: 'https://pypi.org/simple/',
    aliyun: 'https://mirrors.aliyun.com/pypi/simple/',
    tuna: 'https://pypi.tuna.tsinghua.edu.cn/simple/',
    huaweicloud: 'https://repo.huaweicloud.com/repository/pypi/simple/',
  },
};

/* ------------------------------------------------------------------ helpers */

function humanBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

function humanSecs(s) {
  if (!Number.isFinite(s) || s < 0) return '?';
  if (s < 1) return '<1s';
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  if (m < 60) return `${m}m${String(sec).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

const mbps = bytesPerSec => bytesPerSec / 1024 / 1024;

function bar(done, total) {
  const w = 24;
  if (!total) return '.'.repeat(w);
  const filled = Math.max(0, Math.min(w, Math.round((done / total) * w)));
  return '#'.repeat(filled) + '.'.repeat(w - filled);
}

/* ---------------------------------------------------------------- measuring */

/**
 * Stream a URL for at most `limitBytes` / `maxMs` and report what actually happened.
 * Returns { ok, partial, ttfbMs, bytes, elapsedMs, speed, status, error }.
 */
async function measure(url, { limitBytes = 256 * 1024, maxMs = 10000, method = 'GET', headers = {} } = {}) {
  const t0 = performance.now();
  let ttfbMs = null;
  let bytes = 0;
  let status = 0;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), maxMs);
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      signal: ac.signal,
      headers: { 'user-agent': UA, accept: '*/*', 'accept-encoding': 'identity', ...headers },
    });
    status = res.status;
    ttfbMs = performance.now() - t0;
    if (!res.ok && res.status !== 206) {
      try { await res.body?.cancel(); } catch {}
      return { ok: false, ttfbMs, bytes: 0, elapsedMs: performance.now() - t0, speed: 0, status, error: `HTTP ${res.status}` };
    }
    if (!res.body) return { ok: true, ttfbMs, bytes: 0, elapsedMs: performance.now() - t0, speed: 0, status, error: 'no body' };
    const reader = res.body.getReader();
    while (bytes < limitBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
    }
    try { await reader.cancel(); } catch {}
    const elapsedMs = performance.now() - t0;
    const transferMs = Math.max(1, elapsedMs - (ttfbMs ?? 0));
    return { ok: true, ttfbMs, bytes, elapsedMs, speed: (bytes / transferMs) * 1000, status, error: null };
  } catch (e) {
    const elapsedMs = performance.now() - t0;
    const transferMs = Math.max(1, elapsedMs - (ttfbMs ?? 0));
    // A timeout that still delivered bytes is a SLOW endpoint, not a dead one.
    if (bytes > 0) {
      return {
        ok: true, partial: true, ttfbMs, bytes, elapsedMs,
        speed: (bytes / transferMs) * 1000, status,
        error: `slow: still streaming after ${maxMs}ms`,
      };
    }
    const error = e.name === 'AbortError' ? `timeout ${maxMs}ms` : (e.cause?.code || e.message);
    return { ok: false, ttfbMs, bytes, elapsedMs, speed: 0, status, error };
  } finally {
    clearTimeout(timer);
  }
}

/** Get total size of a URL (HEAD, fall back to a 1-byte range request). */
async function contentLength(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const head = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ac.signal, headers: { 'user-agent': UA } });
    const len = Number(head.headers.get('content-length'));
    if (head.ok && Number.isFinite(len) && len > 0) return { total: len, ranges: true };
    const res = await fetch(url, { redirect: 'follow', signal: ac.signal, headers: { 'user-agent': UA, range: 'bytes=0-0' } });
    const cr = res.headers.get('content-range');
    try { await res.body?.cancel(); } catch {}
    if (cr) {
      const m = /\/(\d+)$/.exec(cr);
      if (m) return { total: Number(m[1]), ranges: true };
    }
    return { total: null, ranges: /bytes/.test(head.headers.get('accept-ranges') || '') };
  } catch {
    return { total: null, ranges: false };
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------- probe */

async function cmdProbe(kind = 'all', json = false) {
  const groups = kind === 'all' ? Object.keys(ENDPOINTS) : [kind];
  const out = {};
  for (const g of groups) {
    if (!ENDPOINTS[g]) { console.error(`unknown group: ${g}`); process.exit(2); }
    const rows = [];
    for (const ep of ENDPOINTS[g]) {
      const r = await measure(ep.url, { limitBytes: 256 * 1024, maxMs: ep.maxMs || 8000 });
      rows.push({ endpoint: ep.name, url: ep.url, ...r });
    }
    rows.sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      return b.speed - a.speed || (a.ttfbMs || 1e9) - (b.ttfbMs || 1e9);
    });
    out[g] = rows;
  }
  if (json) { console.log(JSON.stringify(out, null, 2)); return; }

  for (const g of groups) {
    console.log(`\n[${g}]`);
    console.log('  endpoint        TTFB      speed        status');
    console.log('  ' + '-'.repeat(54));
    const best = out[g].find(r => r.ok && r.speed > 20 * 1024);
    for (const r of out[g]) {
      const ttfb = r.ttfbMs == null ? '     -' : `${Math.round(r.ttfbMs)}ms`.padStart(6);
      const sp = r.ok ? `${mbps(r.speed).toFixed(2)} MB/s`.padStart(11) : `${(r.error || 'fail')}`.slice(0, 20).padStart(11);
      const note = r.partial ? 'slow-but-alive' : r.ok ? 'ok' : 'FAILED';
      const mark = r === best ? '  <-- fastest' : '';
      console.log(`  ${r.endpoint.padEnd(14)} ${ttfb} ${sp}   ${note}${mark}`);
    }
  }
  console.log('\nrecommended:');
  for (const g of groups) {
    const b = out[g].find(r => r.ok && r.speed > 20 * 1024) || out[g].find(r => r.ok);
    if (b) console.log(`  ${g} -> ${b.endpoint} (${mbps(b.speed).toFixed(2)} MB/s)`);
    else console.log(`  ${g} -> NOTHING REACHABLE`);
  }
  console.log('\nrun "netx fix" to print the config commands.');
}

/* ---------------------------------------------------------------------- eta */

async function cmdEta(url, json = false) {
  const { total } = await contentLength(url);
  const sample = await measure(url, { limitBytes: 512 * 1024, maxMs: 12000 });
  const speed = sample.speed;
  const etaSec = total && speed > 0 ? Math.max(0, (total - sample.bytes) / speed) : null;
  const result = {
    url,
    ok: sample.ok,
    bytesProbed: sample.bytes,
    total,
    ttfbMs: sample.ttfbMs == null ? null : Math.round(sample.ttfbMs),
    speedBps: Math.round(speed),
    speedMBps: Number(mbps(speed).toFixed(2)),
    etaSec: etaSec == null ? null : Math.round(etaSec),
    etaHuman: etaSec == null ? null : humanSecs(etaSec),
    partial: !!sample.partial,
    warning: null,
  };
  if (!sample.ok) result.warning = `cannot measure: ${sample.error}`;
  else if (speed < 50 * 1024) result.warning = 'very slow (<50 KB/s): switch mirror before downloading';
  else if (speed < 300 * 1024) result.warning = 'slow (<300 KB/s): consider a mirror';
  else if (sample.ttfbMs > 4000) result.warning = 'high latency: connection may be proxied';

  if (json) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log(`url       ${url}`);
  console.log(`total     ${total ? humanBytes(total) : 'unknown (no content-length)'}`);
  console.log(`ttfb      ${result.ttfbMs == null ? '?' : result.ttfbMs + 'ms'}`);
  console.log(`speed     ${result.speedMBps.toFixed(2)} MB/s`);
  console.log(`eta       ${result.etaHuman || 'unknown'}${total && etaSec != null
    ? ` (likely ${humanSecs(etaSec * 0.75)}-${humanSecs(etaSec * 1.25)})`
    : ''}${total && total < 8 * 1024 * 1024 ? '  [small file: rough]' : ''}`);
  if (!total && speed > 0) {
    // No content-length: still answer "how long will this take" at this measured speed.
    console.log(`at ${result.speedMBps.toFixed(2)} MB/s:`);
    for (const mb of [10, 100, 500, 1024]) console.log(`  ${String(mb).padStart(4)} MB -> ${humanSecs((mb * 1024 * 1024) / speed)}`);
  }
  if (result.warning) console.log(`warning   ${result.warning}`);
}

/* ---------------------------------------------------------------------- get */

async function cmdGet(url, outFile, opts = {}) {
  if (!outFile) { console.error('get requires -o <file>'); process.exit(2); }
  const abs = path.resolve(outFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });

  let have = 0;
  try { have = fs.statSync(abs).size; } catch {}
  const { total: knownTotal, ranges } = await contentLength(url);
  let total = knownTotal;

  const headers = { 'user-agent': UA, 'accept-encoding': 'identity' };
  const doResume = have > 0 && ranges;
  if (doResume) headers.range = `bytes=${have}-`;

  const ac = new AbortController();
  const stallMs = opts.stallMs ?? 20000;
  let lastActivity = performance.now();
  let warned = false;
  const watchdog = setInterval(() => {
    const idle = performance.now() - lastActivity;
    if (idle > stallMs) {
      console.error(`\n! stalled: no data for ${Math.round(idle / 1000)}s -> aborting`);
      ac.abort();
    } else if (idle > Math.min(10000, stallMs / 2) && !warned) {
      warned = true;
      process.stderr.write(`\n  ! no data for ${Math.round(idle / 1000)}s - will abort at ${Math.round(stallMs / 1000)}s\n`);
    }
  }, 1000);

  const t0 = performance.now();
  let firstByte = null;
  let written = have;
  let lastTick = performance.now();
  let lastTickBytes = written;

  let res;
  try {
    res = await fetch(url, { headers, redirect: 'follow', signal: ac.signal });
  } catch (e) {
    clearInterval(watchdog);
    console.error(`! request failed: ${e.cause?.code || e.message}`);
    process.exit(3);
  }
  if (!res.ok && res.status !== 206) {
    clearInterval(watchdog);
    console.error(`! HTTP ${res.status} ${res.statusText}`);
    process.exit(3);
  }
  const cl = Number(res.headers.get('content-length'));
  if (res.status === 206) {
    const m = /\/(\d+)$/.exec(res.headers.get('content-range') || '');
    if (m) total = Number(m[1]);
  } else if (Number.isFinite(cl) && cl > 0) {
    total = cl;
    written = 0; // server ignored the range: start over
  }

  const appending = doResume && res.status === 206;
  const out = fs.createWriteStream(abs, { flags: appending ? 'a' : 'w' });
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByte == null) firstByte = performance.now() - t0;
      lastActivity = performance.now();
      written += value.byteLength;
      if (!out.write(Buffer.from(value))) await new Promise(r => out.once('drain', r));
      const now = performance.now();
      if (now - lastTick > 500) {
        const inst = ((written - lastTickBytes) / (now - lastTick)) * 1000;
        lastTick = now; lastTickBytes = written;
        const pct = total ? (written / total) * 100 : null;
        const eta = total && inst > 0 ? (total - written) / inst : null;
        process.stdout.write(
          `\r  ${pct == null ? '--' : pct.toFixed(1)}% [${bar(written, total)}] ` +
          `${humanBytes(written)}${total ? '/' + humanBytes(total) : ''} ` +
          `${mbps(inst).toFixed(2)} MB/s eta ${eta == null ? '?' : humanSecs(eta)}   `
        );
      }
    }
  } catch (e) {
    clearInterval(watchdog);
    try { out.end(); } catch {}
    if (e.name === 'AbortError') {
      console.error(`\n! download stalled at ${humanBytes(written)}. Retry with a mirror:`);
      console.error('  netx eta <mirror-url>');
      process.exit(4);
    }
    console.error(`\n! download failed: ${e.cause?.code || e.message}`);
    process.exit(5);
  } finally {
    clearInterval(watchdog);
  }
  await new Promise(r => out.end(r));
  const elapsed = (performance.now() - t0) / 1000;
  process.stdout.write('\n');
  console.log(`done      ${abs}`);
  console.log(`size      ${humanBytes(written)}${appending ? ' (resumed)' : ''}`);
  console.log(`avg speed ${mbps(written / Math.max(0.001, elapsed)).toFixed(2)} MB/s over ${humanSecs(elapsed)}`);
  console.log(`ttfb      ${firstByte == null ? '?' : Math.round(firstByte) + 'ms'}`);
}

/* ---------------------------------------------------------------------- fix */

async function cmdFix() {
  const results = {};
  for (const g of ['npm', 'pypi']) {
    const rows = [];
    for (const ep of ENDPOINTS[g]) {
      const r = await measure(ep.url, { limitBytes: 128 * 1024, maxMs: 6000 });
      rows.push({ name: ep.name, ...r });
    }
    rows.sort((a, b) => (a.ok === b.ok ? b.speed - a.speed : a.ok ? -1 : 1));
    results[g] = rows;
  }
  for (const g of ['npm', 'pypi']) {
    const best = results[g].find(r => r.ok && r.speed > 20 * 1024) || results[g][0];
    console.log(`\n# ${g}: fastest = ${best.name} (${mbps(best.speed).toFixed(2)} MB/s)`);
    if (!best.ok) { console.log(`# nothing reachable for ${g}`); continue; }
    for (const line of FIX_HINTS[g](REGISTRY[g][best.name])) console.log(line);
  }
  console.log('\n# github');
  for (const line of FIX_HINTS.github()) console.log(line);
}

/* --------------------------------------------------------------------- help */

function usage() {
  console.log(`netx ${VERSION} - know the speed before you wait for it

usage
  netx probe [npm|pypi|github|all]   rank mirrors by TTFB + real throughput
  netx eta <url> [--json]            measure a URL, then predict the total time
  netx get <url> -o <file>           download with progress, ETA, stall detection
                                     [--stall-ms 20000]
  netx fix                           print the fastest-mirror config commands
  netx --version | --help
`);
}

/* ---------------------------------------------------------------------- main */

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = name => argv.includes(name);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const json = flag('--json');

if (!cmd || flag('--help') || cmd === 'help') { usage(); process.exit(0); }
if (flag('--version') || cmd === '-v') { console.log(VERSION); process.exit(0); }

try {
  if (cmd === 'probe') {
    await cmdProbe(argv[1] && !argv[1].startsWith('-') ? argv[1] : 'all', json);
  } else if (cmd === 'eta') {
    if (!argv[1]) { usage(); process.exit(2); }
    await cmdEta(argv[1], json);
  } else if (cmd === 'get') {
    await cmdGet(argv[1], opt('-o', null), { stallMs: Number(opt('--stall-ms', 20000)) });
  } else if (cmd === 'fix') {
    await cmdFix();
  } else {
    console.error(`unknown command: ${cmd}`);
    usage();
    process.exit(2);
  }
} catch (e) {
  console.error(`! ${e.message}`);
  process.exit(1);
}
