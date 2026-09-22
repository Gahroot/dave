// Private stdio guardian: when the server dies its pipe closes, so the entire
// owned process group ends rather than leaving a paid agent running unattended.
import { spawn } from 'node:child_process';
const [command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: ['pipe', 'inherit', 'inherit'], shell: false });
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {});
process.stdin.on('end', () => {
  try { process.kill(-process.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
});
child.on('error', () => process.exit(127));
child.on('exit', code => {
  // The group can still contain tool children. The parent also tears down the
  // group on exit; never let a successful agent leave background tool jobs.
  process.exit(code ?? 1);
});
