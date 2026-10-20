// Native port of src/ui/mascot/MoodGallery.tsx: every DAVE mood with its caption.
import { Text, View } from "react-native";
import { DAVE_MOODS, MOOD_LABEL } from "../../../../src/ui/mascot/types.ts";
import { DaveMascot } from "./DaveMascot.tsx";

/** Tile colours from mascot.css (.dave-gallery__*). */
const STAGE = "#0a0a0c";
const STAGE_BORDER = "#24202f";
const CAPTION = "#d6ceff";

export function MoodGallery({ size = 72 }: { size?: number }) {
  return (
    <View accessibilityRole="list" accessibilityLabel="DAVE's moods" style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
      {DAVE_MOODS.map((mood) => (
        <View
          key={mood}
          accessible
          accessibilityRole="image"
          accessibilityLabel={`DAVE is ${MOOD_LABEL[mood]}`}
          style={{ alignItems: "center", gap: 6, paddingTop: 10, paddingHorizontal: 10, paddingBottom: 8, borderRadius: 14, backgroundColor: STAGE, borderWidth: 1, borderColor: STAGE_BORDER }}
        >
          <DaveMascot mood={mood} size={size} label="" />
          <Text style={{ fontSize: 12, color: CAPTION, textTransform: "capitalize" }} importantForAccessibility="no">{MOOD_LABEL[mood]}</Text>
        </View>
      ))}
    </View>
  );
}
