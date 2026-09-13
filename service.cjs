#!/usr/bin/env node
/**
 * cproxy service manager (Windows)
 * --------------------------------
 * Registers proxy.mjs as a real Windows service via the `node-windows` package
 * — starts at boot, survives logoff, auto-restarts on crash. The SCM service id
 * is "cproxy.exe" (that's what node-windows/WinSW register); display name "cproxy".
 *
 * PORT and HOST are passed to proxy.mjs as startup parameters (--port/--host).
 * They live in the WinSW config file daemon\cproxy.xml AND in the registry
 * (HKLM\SYSTEM\CurrentControlSet\Services\cproxy.exe\Parameters), so they can be
 * changed without touching code:
 *
 *   node service.cjs install [PORT] [HOST]    register + start  (needs admin)
 *   node service.cjs set --port N [--host H] [--upstream URL] [--backend llama-server|vllm]
 *                                              change params, restarts (admin)
 *   node service.cjs uninstall                stop + remove     (needs admin)
 *   node service.cjs start | stop | restart
 *   node service.cjs status                   state + current params (no admin)
 *
 * The proxy itself stays zero-dependency; `node-windows` is only needed here,
 * and install.cmd drops a local copy into vendor/ so this works offline.
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const DIR = __dirname;
const NAME = 'cproxy'; // display name / node-windows id
const SCM_ID = `${NAME}.exe`; // actual service id in the SCM and registry
const REG_KEY = `HKLM\\SYSTEM\\CurrentControlSet\\Services\\${SCM_ID}`;
const XML_FILE = path.join(DIR, 'daemon', `${NAME}.xml`);

// Prefer the bundled portable Node (runtime\node) if install.cmd placed one —
// services don't inherit your user PATH, so a fixed node.exe is more robust.
function pickNode() {
  const bundled = path.join(DIR, 'runtime', 'node', 'node.exe');
  return fs.existsSync(bundled) ? bundled : process.execPath;
}

let Service;
try {
  ({ Service } = require(path.join(DIR, 'vendor', 'node_modules', 'node-windows')));
} catch {
  console.error('[cproxy] node-windows not found in vendor/ — run install.cmd first (it does: npm install --prefix vendor node-windows).');
  process.exit(1);
}

function makeService(port, host) {
  return new Service({
    name: NAME,
    description: 'cproxy - Anthropic-to-OpenAI translation proxy for Claude Code -> llama.cpp',
    node: pickNode(),
    script: path.join(DIR, 'proxy.mjs'),
    workingDirectory: DIR, // so proxy.env / logs resolve next to the project
    logpath: path.join(DIR, 'logs'),
    out: 'cproxy-out.log',
    err: 'cproxy-err.log',
    // Startup parameters for proxy.mjs — baked into daemon\cproxy.xml at install.
    scriptOptions: `--port ${port} --host ${host}`,
  });
}

// Minimal Service for start/stop/restart/status — node-windows still needs the
// script path to derive its working directory, so carry it even though we're
// not (re)installing anything.
function controlService() {
  return new Service({ name: NAME, script: path.join(DIR, 'proxy.mjs') });
}

/** Current SCM state of the service ('RUNNING'/'STOPPED'/... or null if absent). */
function scState() {
  try {
    const out = execFileSync('sc.exe', ['query', SCM_ID], { encoding: 'utf8' });
    return /STATE\s*:\s*\S+\s+(\w+)/.exec(out)?.[1] || null;
  } catch {
    return null;
  }
}

/**
 * Robust restart. node-windows' own restart() is broken: it ignores its
 * callback and fires NET START the instant the stop event lands, before the
 * SCM has finished tearing down — so the start silently loses the race and
 * the service ends up STOPPED. We do it by hand: stop, poll until stopped,
 * then start with a real callback.
 */
function robustRestart(cb) {
  const svc = controlService();
  svc.once('stop', () => waitThenStart());
  svc.once('alreadystopped', () => waitThenStart());
  let tries = 0;
  function waitThenStart() {
    setTimeout(() => {
      if (scState() !== 'STOPPED' && ++tries < 20) return waitThenStart(); // up to ~10s
      svc.start((err) => cb(err));
    }, 500);
  }
  svc.stop();
}

// console.log + immediate process.exit can drop output when stdout is a file;
// give the stream a moment to flush first.
function done(ok, msg) {
  process.stdout.write(`[cproxy] ${msg}\n`);
  setTimeout(() => process.exit(ok ? 0 : 1), 150);
}

/** Current startup parameters: daemon\cproxy.xml is authoritative (WinSW reads it). */
function readParams() {
  try {
    const xml = fs.readFileSync(XML_FILE, 'utf8');
    const m = /--scriptoptions=(.*?)<\/argument>/.exec(xml);
    if (m && m[1]) return m[1];
  } catch {}
  try {
    const out = execFileSync('reg', ['query', REG_KEY, '/v', 'Parameters'], { encoding: 'utf8' });
    return /Parameters\s+REG_SZ\s+(.*)$/.exec(out)?.[1]?.trim() || null;
  } catch {
    return null; // service not installed
  }
}

function buildParams(port, host, upstream, backend) {
  return `--port ${port} --host ${host}${upstream ? ` --upstream ${upstream}` : ''}${backend ? ` --backend ${backend}` : ''}`;
}

function writeParams(port, host, upstream, backend) {
  const params = buildParams(port, host, upstream, backend);
  // 1. WinSW config (what the service actually reads on start).
  if (fs.existsSync(XML_FILE)) {
    let xml = fs.readFileSync(XML_FILE, 'utf8');
    xml = xml.replace(/<argument>--scriptoptions=.*?<\/argument>/, `<argument>--scriptoptions=${params}</argument>`);
    fs.writeFileSync(XML_FILE, xml);
  }
  // 2. Registry (visible in regedit / service tools; WinSW also honors it).
  try {
    execFileSync('reg', ['add', REG_KEY, '/v', 'Parameters', '/t', 'REG_SZ', '/d', params, '/f'], { stdio: 'ignore' });
  } catch {}
}

const cmd = (process.argv[2] || '').toLowerCase();

switch (cmd) {
  case 'install': {
    const port = process.argv[3] || '8787';
    const host = process.argv[4] || '127.0.0.1';
    const svc = makeService(port, host);
    svc.on('exists', () => done(true, `service "${SCM_ID}" already installed (params: ${readParams()}) — use "set" to change them`));
    svc.on('invalid', (e) => done(false, `could not install: ${e}`));
    svc.on('install', () => {
      writeParams(port, host); // make the params visible in registry too
      console.log(`[cproxy] service "${SCM_ID}" registered with params "--port ${port} --host ${host}" — starting it...`);
      const s2 = controlService();
      s2.start((err) => done(!err, err ? `started but: ${err}` : 'service installed and running'));
    });
    svc.install();
    break;
  }

  case 'set': {
    // node service.cjs set --port N [--host H] [--upstream URL|""] [--backend llama-server|vllm|""]   ("" = drop flag, fall back to proxy.env)
    const args = process.argv.slice(3);
    let port, host, upstream, backend;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--port') port = args[++i];
      else if (args[i] === '--host') host = args[++i];
      else if (args[i] === '--upstream') upstream = args[++i];
      else if (args[i] === '--backend') backend = args[++i];
    }
    const cur = readParams();
    if (!cur) done(false, 'service not installed — run install first');
    port = port ?? /--port\s+(\S+)/.exec(cur)?.[1] ?? '8787';
    host = host ?? /--host\s+(\S+)/.exec(cur)?.[1] ?? '127.0.0.1';
    upstream = upstream ?? /--upstream\s+(\S+)/.exec(cur)?.[1] ?? '';
    backend = backend ?? /--backend\s+(\S+)/.exec(cur)?.[1] ?? '';
    const params = buildParams(port, host, upstream, backend);
    writeParams(port, host, upstream, backend);
    console.log(`[cproxy] startup parameters set to "${params}" — restarting service...`);
    robustRestart((err) => done(!err, err ? `restarted but: ${err}` : 'service restarted with new parameters'));
    break;
  }

  case 'uninstall': {
    const svc = makeService(0, 0); // params irrelevant for removal
    svc.on('notfound', () => done(true, `service "${SCM_ID}" was not installed`));
    svc.on('invalid', (e) => done(false, `could not uninstall: ${e}`));
    svc.on('uninstall', () => done(true, 'service removed'));
    svc.uninstall();
    break;
  }

  case 'start': {
    controlService().start((err) => done(!err, err ? `start failed: ${err}` : 'service started'));
    break;
  }

  case 'stop': {
    controlService().stop((err) => done(!err, err ? `stop failed: ${err}` : 'service stopped'));
    break;
  }

  case 'restart': {
    robustRestart((err) => done(!err, err ? `restart failed: ${err}` : 'service restarted'));
    break;
  }

  case 'status': {
    let out = '';
    try {
      out = execFileSync('sc.exe', ['query', SCM_ID], { encoding: 'utf8' });
    } catch {
      done(false, `service "${SCM_ID}" not found — run install.cmd`);
    }
    const state = /STATE\s*:\s*\S+\s+(\w+)/.exec(out)?.[1] || 'UNKNOWN';
    console.log(`[cproxy] service "${SCM_ID}": ${state}`);
    const params = readParams();
    if (params) console.log(`[cproxy] startup parameters: ${params}`);
    process.exit(state === 'RUNNING' ? 0 : 2);
  }

  default:
    console.error('usage: node service.cjs install [PORT] [HOST] | set --port N [--host H] [--upstream URL] [--backend llama-server|vllm] | uninstall | start | stop | restart | status');
    process.exit(1);
}
