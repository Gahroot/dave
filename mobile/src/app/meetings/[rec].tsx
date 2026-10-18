import { Stack, useLocalSearchParams } from "expo-router";
import { MeetingDetailScreen } from "../../features/meetings/MeetingDetailScreen";
import { recordingId } from "../../features/meetings/model";
import { EmptyState, Panel, Screen } from "../../ui/primitives";

export default function MeetingRoute() {
  const { rec } = useLocalSearchParams<{ rec?: string }>();
  const id = recordingId(rec);
  if (!id) return <Screen><Stack.Screen options={{ title: "Meeting unavailable" }} />
    <Panel><EmptyState title="This meeting is not in DAVE" message="It may have been forgotten, or the link is out of date." /></Panel></Screen>;
  return <MeetingDetailScreen key={id} recordingId={id} />;
}
