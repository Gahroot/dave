import { DaveMascot } from "./DaveMascot.tsx";
import { DAVE_MOODS, MOOD_LABEL } from "./types.ts";
import "./mascot.css";

/** Every DAVE mood side by side, for the "Meet DAVE" sheet. */
export function MoodGallery({ size = 72 }: { size?: number }) {
  return (
    <ul className="dave-gallery" aria-label="DAVE's moods">
      {DAVE_MOODS.map((mood) => (
        <li key={mood} className="dave-gallery__tile">
          <DaveMascot mood={mood} size={size} />
          <span className="dave-gallery__caption" aria-hidden="true">{MOOD_LABEL[mood]}</span>
        </li>
      ))}
    </ul>
  );
}
