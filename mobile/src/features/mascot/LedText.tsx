// Native port of src/ui/mascot/LedText.tsx: 5x7 dot-matrix label as react-native-svg circles.
import { useMemo } from "react";
import { View } from "react-native";
import Svg, { Circle, G } from "react-native-svg";
import { layoutLedText } from "../../../../src/ui/mascot/font5x7.ts";

/** Colours from src/ui/mascot/mascot.css (.dave-led--*); glow approximates its 2px drop-shadow. */
const TONE = { lit: "#9d8cff", dim: "#8a80b8", oops: "#ff6b60" } as const;

export function LedText({ text, tone = "lit", dot = 3, label }: { text: string; tone?: "lit" | "dim" | "oops"; dot?: number; label?: string }) {
  const pitch = dot > 0 && Number.isFinite(dot) ? dot : 3;
  const { cells, width, height } = useMemo(() => layoutLedText(text), [text]);
  const color = TONE[tone];
  const r = pitch * 0.4;
  const w = Math.max(pitch, width * pitch);
  const h = height * pitch;
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label ?? text} style={{ width: w, height: h }}>
      <Svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} pointerEvents="none">
        <G fill={color} fillOpacity={0.25}>
          {cells.map((c) => <Circle key={`g${c.x}:${c.y}`} cx={(c.x + 0.5) * pitch} cy={(c.y + 0.5) * pitch} r={r + Math.min(2, pitch * 0.35)} />)}
        </G>
        <G fill={color}>
          {cells.map((c) => <Circle key={`${c.x}:${c.y}`} cx={(c.x + 0.5) * pitch} cy={(c.y + 0.5) * pitch} r={r} />)}
        </G>
      </Svg>
    </View>
  );
}
