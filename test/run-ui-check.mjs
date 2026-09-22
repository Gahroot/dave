// Isolated browser verification. Requires an existing Playwright/Chromium installation;
// accepts PLAYWRIGHT_MODULE and PLAYWRIGHT_EXECUTABLE without installing anything.
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const targets = {
  delivery: ['test/delivery-ui-fixture.ts', 'test/delivery-ui-walkthrough.mjs', 4320],
  coordination: ['test/delivery-ui-fixture.ts', 'test/coordination-ui-walkthrough.mjs', 4320],
  agent: ['test/agent-ui-fixture.ts', 'test/agent-ui-walkthrough.mjs', 4323],
};
const target = Object.hasOwn(targets, process.argv[2]) && targets[process.argv[2]];
if (!target) throw Error('Choose delivery, coordination or agent');
const [fixture, walkthrough, port] = target;
const server = spawn(process.execPath, ['--experimental-strip-types', fixture], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
let check;
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try { await exited; } finally { clearTimeout(timer); }
}
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Fixture readiness timeout')), 30000);
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', status => { clearTimeout(timer); reject(Error(`Fixture exited ${status}`)); });
    let output = '';
    server.stdout.on('data', chunk => {
      process.stdout.write(chunk);
      output = (output + chunk).slice(-4096);
      if (/fixture ready/i.test(output)) { clearTimeout(timer); resolve(); }
    });
  });
  const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error(`Fixture HTTP ${response.status}`);
  await response.body?.cancel();
  check = spawn(process.execPath, [walkthrough], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, ...(process.argv[2] === 'agent' ? { AGENT_UI_FIXTURE_PID: String(server.pid) } : {}) },
  });
  server.on('message', message => {
    if (message === 'agent-fixture-restarted' && check.connected) check.send(message);
  });
  const [code] = await once(check, 'exit');
  process.exitCode = code ?? 1;
} finally {
  await stop(check);
  await stop(server);
}
