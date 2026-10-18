import { layoutLedText } from "./font5x7.ts";
import type { LedTextProps } from "./types.ts";
import "./mascot.css";

/** Dot-matrix glowing label (5x7 font) drawn as inline SVG circles; the text itself is the accessible name. */
export function LedText({ text, tone = "lit", dot = 3, label, className }: LedTextProps) {
  const pitch = dot > 0 && Number.isFinite(dot) ? dot : 3;
  const { cells, width, height } = layoutLedText(text);
  const r = pitch * 0.4;
  const w = Math.max(pitch, width * pitch);
  const h = height * pitch;
  const cls = ["dave-led", `dave-led--${tone}`, className ?? ""].filter(Boolean).join(" ");
  return (
    <span className={cls} role="img" aria-label={label ?? text} data-tone={tone}>
      <svg className="dave-led__dots" aria-hidden="true" focusable="false" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        {cells.map((c) => <circle key={`${c.x}:${c.y}`} cx={(c.x + 0.5) * pitch} cy={(c.y + 0.5) * pitch} r={r} />)}
      </svg>
    </span>
  );
}
