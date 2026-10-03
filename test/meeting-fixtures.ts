import type { FathomMeeting } from '../src/meetings/fathom-client.ts';

export const meetingFixture = (id: string, over: Partial<FathomMeeting> = {}): FathomMeeting => ({
  recordingId: id,
  title: `Meeting ${id}`,
  calendarTitle: null,
  url: `https://fathom.video/calls/${id}`,
  shareUrl: null,
  createdAt: '2026-09-28T17:00:00.000Z',
  startedAt: '2026-09-28T16:00:00.000Z',
  endedAt: '2026-09-28T17:00:00.000Z',
  recordedBy: 'dave@studio.dev',
  external: true,
  attendees: [
    { name: 'Dave Owner', email: 'dave@studio.dev', domain: 'studio.dev', external: false, speakerName: 'Dave Owner' },
    { name: 'Jane Client', email: 'jane@acme.com', domain: 'acme.com', external: true, speakerName: null },
  ],
  ...over,
});
