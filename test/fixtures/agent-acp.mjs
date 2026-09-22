// Real local process used by integration tests; no provider or network calls.
import readline from 'node:readline';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const reply = (id, result) => send({ id, result });
const output = text => send({ method: 'session/update', params: { sessionId: 'fixture-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
let waiting;
function finish(id, prompt) {
  if (prompt.includes('CHANGE')) fs.writeFileSync('work.txt', prompt.includes('FOLLOWUP') ? 'revised\n' : 'implemented\n');
  output(prompt.includes('FOLLOWUP') ? 'Follow-up in the same session.\n' : 'Fixture agent completed its turn.\n');
  const template = /\n(\{"version":1,"projectId":[^\n]+\})/.exec(prompt);
  if (template) {
    const report = JSON.parse(template[1]);
    report.outcome = 'Fixture change completed';
    report.criteria = report.criteria.map(c => ({ ...c, status: 'met', evidence: 'Fixture process produced the requested file.' }));
    report.commands = [{ command: 'fixture', exitCode: 0, evidence: 'Synthetic fixture completed.' }];
    output('DAVE_REPORT_BEGIN\n' + JSON.stringify(report) + '\nDAVE_REPORT_END');
  }
  reply(id, { stopReason: 'end_turn' });
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') reply(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
  else if (m.method === 'session/new') reply(m.id, { sessionId: 'fixture-session' });
  else if (m.method === 'session/load') { output('Existing session loaded.\n'); reply(m.id, {}); }
  else if (m.method === 'session/prompt') {
    const prompt = m.params.prompt[0].text;
    if (prompt.includes('CHATTER')) { for (let i=0; i<2100; i++) output('Synthetic output '.repeat(64)); }
    if (prompt.includes('FLOOD')) { process.stdout.write('x'.repeat(600000)); return; }
    if (prompt.includes('SPAWN_CHILD')) { const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); fs.writeFileSync('child.pid', String(c.pid)); }
    if (/\bHANG\b/.test(prompt)) { output('Still working.\n'); return; }
    if (prompt.includes('WAIT_PERMISSION')) {
      waiting = { id: m.id, prompt };
      send({ id: 'permission-1', method: 'session/request_permission', params: { sessionId: 'fixture-session', toolCall: { title: 'Allow fixture edit?' }, options: [{ optionId: 'once', name: 'Allow this edit', kind: 'allow_once' }, { optionId: 'always', name: 'Allow all edits', kind: 'allow_always' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] } });
    } else finish(m.id, prompt);
  } else if (m.id === 'permission-1' && waiting) {
    if (m.result.outcome.optionId === 'once') finish(waiting.id, waiting.prompt);
    else reply(waiting.id, { stopReason: 'cancelled' });
    waiting = undefined;
  } else if (m.method === 'session/cancel') process.exit(0);
});
