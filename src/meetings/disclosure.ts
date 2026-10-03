import { createHash } from 'node:crypto';
import type { Disclosure } from './types.ts';

/**
 * Exactly what leaves this Mac when meeting analysis is on. The UI renders this
 * text as sent by the server, and consent is tied to its hash: any change to
 * the wording asks for consent again.
 */
export const DISCLOSURE: Disclosure = {
  title: 'Send meetings to your OpenAI connection for analysis',
  sections: [
    {
      title: 'Each meeting analysis sends',
      items: [
        'The transcript, with the names and roles (you, client, teammate) of the people in the meeting',
        'The meeting title, date and time, and the company domains of external attendees',
        'Your project names, each with its folder name and a one-line focus',
        'Your open promises from earlier meetings',
        'Your reading instructions',
      ],
    },
    {
      title: 'The follow-up check every 6 hours sends, for each project with open promises and new work',
      items: [
        "The project's name and its open promises",
        'Commit subjects and dates since the meeting',
        'Titles of accepted Agent desk runs',
        'Titles of finished milestones',
        'Titles of done EZBoss tasks',
      ],
    },
  ],
  notes: [
    'Nothing else is sent: no code, no files and no email addresses.',
    'Turning this off stops both automatic analysis and the follow-up check. Meetings are still imported, and you can analyze one at a time.',
    "Transcripts stay in DAVE's database on this Mac.",
  ],
};

export const DISCLOSURE_VERSION = createHash('sha256').update(JSON.stringify(DISCLOSURE)).digest('hex').slice(0, 16);
