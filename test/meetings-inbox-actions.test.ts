import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { memoryKeyStore } from '../src/meetings/credentials.ts';
import { buildServer } from '../src/server/index.ts';
import { sourcePaths } from '../src/shared/paths.ts';
import type { InboxItem, Portfolio } from '../src/shared/types.ts';
import { tempDir, writeJson, writeText } from './helpers.ts';

const roots: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = fs.realpathSync(tempDir('dave-meeting-inbox-'));
  roots.push(root);
  const paths = sourcePaths(path.join(root, 'home'), path.join(root, 'app'));
  const dir = path.join(paths.home, 'code', 'acme');
  writeText(path.join(dir, 'README.md'), '# Acme portal');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  writeJson(paths.ezcoder.appWorkspace, { windows: [{ cwd: dir }] });
  const app = await buildServer(paths, { meetings: { keyStore: memoryKeyStore(), openAIConnected: () => false } });
  apps.push(app);
  const post = async (url: string, payload?: object) => app.inject({ method: 'POST', url, ...(payload ? { payload } : {}) });
  const first = (await post('/api/refresh')).json() as Portfolio;
  const projectId = [...first.active, ...first.other][0]!.id;
  // Pinned: every refresh observes the project and reconciles its rows.
  await post(`/api/projects/${projectId}/override`, { pinned: true });

  // Seed through a second connection, as if a meeting had been analyzed.
  const seed = new DatabaseSync(path.join(paths.appHome, 'pcc.db'));
  const at = new Date().toISOString();
  seed.exec('PRAGMA busy_timeout = 5000');
  seed.prepare(`INSERT INTO meetings(recording_id, title, created_at, started_at, status, first_seen_at, updated_at)
    VALUES ('100', 'Acme weekly', ?, ?, 'analyzed', ?, ?)`).run(at, at, at, at);
  const insert = seed.prepare(`INSERT INTO meeting_items(id, recording_id, kind, text, quote, at_seconds, speaker, speaker_role, project_id, feature_json, status, created_at, updated_at)
    VALUES (?, '100', ?, ?, ?, 30, ?, ?, ?, ?, 'open', ?, ?)`);
  insert.run('mi-promise', 'commitment', 'Send the API docs', "I'll send the API docs by Friday", 'Dave', 'me', projectId, null, at, at);
  insert.run('mi-idea', 'pain_point', 'Export times out', 'The export keeps timing out', 'Jane', 'client', projectId,
    JSON.stringify({ title: 'Background export', outcome: 'Exports finish', acceptance: ['a', 'b'] }), at, at);
  seed.close();

  const status = (id: string) => {
    const read = new DatabaseSync(path.join(paths.appHome, 'pcc.db'), { readOnly: true });
    try { return read.prepare('SELECT status, status_source FROM meeting_items WHERE id = ?').get(id); } finally { read.close(); }
  };
  return { app, post, projectId, status };
}

const meetingRows = (p: Portfolio): InboxItem[] => p.inbox.filter(i => i.kind === 'meeting-promise' || i.kind === 'client-idea');

describe('Inbox actions on meeting rows', () => {
  it('Handled marks the promise done, Undo reopens it, Dismiss drops it', async () => {
    const f = await fixture();
    const refreshed = (await f.post('/api/refresh')).json() as Portfolio;
    const promise = meetingRows(refreshed).find(i => i.kind === 'meeting-promise')!;
    const idea = meetingRows(refreshed).find(i => i.kind === 'client-idea')!;
    expect(promise).toMatchObject({ urgency: 60, projectId: f.projectId });
    expect(idea).toMatchObject({ urgency: 45, title: expect.stringContaining('Background export') });

    const handled = (await f.post(`/api/attention/${promise.id}/handled`)).json().portfolio as Portfolio;
    expect(f.status('mi-promise')).toMatchObject({ status: 'done', status_source: 'user' });
    expect(meetingRows(handled).map(i => i.kind)).toEqual(['client-idea']);
    // A later refresh does not bring a done promise back.
    expect(meetingRows((await f.post('/api/refresh')).json() as Portfolio).map(i => i.kind)).toEqual(['client-idea']);

    const undone = (await f.post(`/api/attention/${promise.id}/undo`)).json().portfolio as Portfolio;
    expect(f.status('mi-promise')).toMatchObject({ status: 'open' });
    expect(meetingRows(undone).map(i => i.id)).toContain(promise.id);

    await f.post(`/api/attention/${promise.id}/tomorrow`);
    expect(f.status('mi-promise')).toMatchObject({ status: 'open' });
    await f.post(`/api/attention/${promise.id}/undo`);

    await f.post(`/api/attention/${idea.id}/dismiss`);
    expect(f.status('mi-idea')).toMatchObject({ status: 'dropped', status_source: 'user' });
    // The compatibility endpoint behaves the same.
    await f.post(`/api/inbox/${promise.id}/acknowledge`);
    expect(f.status('mi-promise')).toMatchObject({ status: 'done' });
    expect(meetingRows((await f.post('/api/refresh')).json() as Portfolio)).toEqual([]);
  });

  it('rejects unknown Inbox ids without touching promises', async () => {
    const f = await fixture();
    expect((await f.post('/api/attention/unknown/handled')).statusCode).toBe(404);
    expect(f.status('mi-promise')).toMatchObject({ status: 'open' });
  });
});
