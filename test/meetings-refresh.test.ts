import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, type Db } from '../src/db/index.ts';
import { repo as makeRepo, type Repo } from '../src/db/repo.ts';
import { applyMeetingAttention } from '../src/meetings/attention.ts';
import { meetingStore, type MeetingStore } from '../src/meetings/store.ts';
import { refresh } from '../src/model/refresh.ts';
import { sourcePaths } from '../src/shared/paths.ts';
import type { Portfolio } from '../src/shared/types.ts';
import { meetingFixture } from './meeting-fixtures.ts';
import { NOW, tempDir, writeJson, writeText } from './helpers.ts';

const roots: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.realpathSync(tempDir('dave-meeting-refresh-'));
  roots.push(root);
  const paths = sourcePaths(path.join(root, 'home'), path.join(root, 'app'));
  const dir = path.join(paths.home, 'code', 'acme');
  writeText(path.join(dir, 'README.md'), '# Acme portal\nClient portal.');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  writeJson(paths.ezcoder.appWorkspace, { windows: [{ cwd: dir }] });
  const db = openDb(paths.appHome);
  dbs.push(db);
  return { paths, repo: makeRepo(db), store: meetingStore(db), db };
}

const all = (p: Portfolio) => [...p.active, ...p.other];

function addPromise(store: MeetingStore, db: Db, projectId: string, id = 'mi-1'): void {
  store.upsertMeeting(meetingFixture('100', { startedAt: '2026-08-31T16:00:00.000Z', createdAt: '2026-08-31T16:00:00.000Z' }), NOW.toISOString());
  db.prepare(`INSERT INTO meeting_items(id, recording_id, kind, text, quote, at_seconds, speaker, speaker_role, project_id, due_date, status, created_at, updated_at)
    VALUES (?, '100', 'commitment', 'Send the API docs', 'I''ll send the API docs by Friday', 90, 'Dave Owner', 'me', ?, '2026-09-04', 'open', ?, ?)`)
    .run(id, projectId, NOW.toISOString(), NOW.toISOString());
}

describe('meeting attention inside refresh', () => {
  it('survives reconcileAttention switching off every row of an observed project', async () => {
    const { paths, repo, store, db } = fixture();
    const hooks = (r: Repo) => ({ attention: (visible: Parameters<typeof applyMeetingAttention>[2], now: Date) =>
      applyMeetingAttention(store, (c, o, at) => r.reconcileAttention(c, o, at), visible, now) });

    const first = await refresh(paths, repo, NOW, hooks(repo));
    const project = all(first)[0]!;
    // Pinned, so generateInbox observes it and switches off all its rows on every refresh.
    repo.setOverride(project.id, { pinned: true }, NOW.toISOString());
    addPromise(store, db, project.id);

    const second = await refresh(paths, repo, NOW, hooks(repo));
    expect(second.active.map(p => p.id)).toContain(project.id);
    const item = second.inbox.find(i => i.kind === 'meeting-promise');
    expect(item).toMatchObject({ projectId: project.id, active: true, status: 'open', urgency: 80, subjectKey: JSON.stringify(['meeting', 'mi-1']),
      evidence: [{ kind: 'meeting', detail: expect.stringContaining("I'll send the API docs by Friday") }] });
    expect(second.today).toContainEqual(expect.objectContaining({ projectId: project.id, title: item?.title, urgency: 80 }));

    // Repeated refreshes keep the same row active instead of recreating it.
    const third = await refresh(paths, repo, NOW, hooks(repo));
    expect(third.inbox.filter(i => i.kind === 'meeting-promise').map(i => i.id)).toEqual([item?.id]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM inbox_items WHERE subject_key = ?`).get(JSON.stringify(['meeting', 'mi-1']))).toMatchObject({ n: 1 });

    // Without the hook, the same refresh would have switched it off: the pitfall this guards.
    const unhooked = await refresh(paths, repo, NOW);
    expect(unhooked.inbox.some(i => i.kind === 'meeting-promise')).toBe(false);
    const restored = await refresh(paths, repo, NOW, hooks(repo));
    expect(restored.inbox.find(i => i.kind === 'meeting-promise')?.id).toBe(item?.id);
  });

  it('drops the Inbox row when the promise closes, and never shows hidden projects', async () => {
    const { paths, repo, store, db } = fixture();
    const hooks = { attention: (visible: Parameters<typeof applyMeetingAttention>[2], now: Date) =>
      applyMeetingAttention(store, (c, o, at) => repo.reconcileAttention(c, o, at), visible, now) };
    const project = all(await refresh(paths, repo, NOW, hooks))[0]!;
    addPromise(store, db, project.id);
    expect((await refresh(paths, repo, NOW, hooks)).inbox.some(i => i.kind === 'meeting-promise')).toBe(true);

    db.prepare(`UPDATE meeting_items SET status = 'done' WHERE id = 'mi-1'`).run();
    expect((await refresh(paths, repo, NOW, hooks)).inbox.some(i => i.kind === 'meeting-promise')).toBe(false);

    db.prepare(`UPDATE meeting_items SET status = 'open' WHERE id = 'mi-1'`).run();
    repo.setOverride(project.id, { hidden: true }, NOW.toISOString());
    const hidden = await refresh(paths, repo, NOW, hooks);
    expect(hidden.inbox.some(i => i.kind === 'meeting-promise')).toBe(false);
    expect(hidden.today).toEqual([]);
  });
});
