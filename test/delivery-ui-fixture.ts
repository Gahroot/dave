// Synthetic-only isolated server: no real provider, Keychain or discovery home.
import fs from 'node:fs';
import path from 'node:path';
import { buildServer } from '../src/server/index.ts';
import { sourcePaths } from '../src/shared/paths.ts';
import { createProviderService, type OwnedAuth } from '../src/providers/index.ts';
import { tempDir, writeJson, writeText } from './helpers.ts';
import type { Portfolio } from '../src/shared/types.ts';
const root = tempDir('delivery-ui-');
const paths = sourcePaths(path.join(root, 'home'), path.join(root, 'app'));
const dir = path.join(paths.home, 'code', 'synthetic-onboarding');
writeText(path.join(dir, 'README.md'), '# Synthetic onboarding\nWhole member onboarding, staff review and operational recovery. No external client data.');
writeJson(path.join(paths.ezcoder.taskProjects, 'synthetic', 'meta.json'), { path: dir, name: 'Synthetic onboarding' });
let connected = true;
const fakeAuth = {
 status: () => ({ provider: 'openai', storage: 'session', state: connected ? 'connected' : 'disconnected', accessToken: 'SYNTHETIC_SECRET_SENTINEL' }),
 restore() {}, async connect() { await new Promise(r => setTimeout(r, 2500)); connected = true; },
 cancel() {}, disconnect() { connected = false; }, dispose() {}, getCredentials() { throw new Error('No credentials in fixture'); },
} as unknown as OwnedAuth;
const plan = { assumptions: ['Synthetic implementation only; no client access or acceptance claimed.'], milestones: ['Whole guided member onboarding', 'Staff review and corrections', 'Daily operational recovery'].map((title, i) => ({ title, outcome: `Deliver ${title.toLowerCase()} with accessible guided steps, validation, durable progress, understandable recovery and a complete usable finish for members returning after interruption.`, whyNow: 'A whole daily capability is needed, not a sample test or a commit instruction.', scope: ['Implement the complete interface, validation, persistence, recovery and end-to-end completion', 'Preserve existing changes and verify the whole workflow using synthetic cases'], exclusions: ['No deployment or real client data'], acceptance: ['A member completes the whole workflow', 'Reload preserves progress and recoverable errors retain input'], sourceIds: [], humanPrerequisites: [], dependencies: i ? [i - 1] : [] })) };
const providers = createProviderService({ authFactory: () => fakeAuth, inference: async () => { await new Promise(r => setTimeout(r, 4500)); return JSON.stringify(plan); } });
providers.restore('session');
const app = await buildServer(paths, { providers, browserOrigins: ['http://127.0.0.1:4320'] });
const portfolio = (await app.inject('/api/portfolio')).json<Portfolio>();
const project = [...portfolio.active, ...portfolio.other][0];
if (!project) throw new Error('Synthetic discovery failed');
await app.inject({ method: 'POST', url: `/api/projects/${project.id}/override`, payload: { pinned: true } });
await app.listen({ host: '127.0.0.1', port: 4320 });
console.log('Delivery synthetic fixture ready http://127.0.0.1:4320');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().then(() => { fs.rmSync(root, { recursive: true, force: true }); process.exit(0); }); });
