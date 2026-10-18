import { useLocalSearchParams } from "expo-router";
import { MeetingsScreen } from "../../features/meetings/MeetingsScreen";
import { parseSection } from "../../features/meetings/model";

/** Meetings tab. Optional `?section=promises|asks|list|instructions`. */
export default function MeetingsTab() {
  const { section } = useLocalSearchParams<{ section?: string }>();
  return <MeetingsScreen initialSection={parseSection(section)} />;
}
