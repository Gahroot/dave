import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ConnectionProvider, useConnection } from "../lib/connection";
import { VoiceDock } from "../features/voice/VoiceDock";
import { VoiceProvider } from "../features/voice/VoiceProvider";
import { LoadingState, SafeScreen } from "../ui/primitives";
import { colors } from "../ui/theme";

export default function RootLayout() {
  return <SafeAreaProvider>
    <ConnectionProvider>
      <StatusBar style="dark" />
      <Navigator />
    </ConnectionProvider>
  </SafeAreaProvider>;
}

/** Everything except pairing requires a stored pairing; nothing else gates on the network. */
function Navigator() {
  const { state } = useConnection();
  if (state.status === "loading") return <SafeScreen><LoadingState label="Opening DAVE…" /></SafeScreen>;
  const paired = state.status === "ready";
  const stack = <Stack screenOptions={{
    headerTintColor: colors.accent,
    headerTitleStyle: { color: colors.ink, fontWeight: "600" },
    headerStyle: { backgroundColor: colors.surface },
    headerShadowVisible: false,
    headerBackButtonDisplayMode: "minimal",
    contentStyle: { backgroundColor: colors.canvas },
  }}>
    <Stack.Protected guard={paired}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false, title: "DAVE" }} />
      <Stack.Screen name="focus/[project]" options={{ title: "Project focus" }} />
      <Stack.Screen name="project/[id]" options={{ title: "Project" }} />
      <Stack.Screen name="delivery/[project]" options={{ title: "Delivery" }} />
      <Stack.Screen name="agents/index" options={{ title: "Agent desk" }} />
      <Stack.Screen name="agents/[id]" options={{ title: "Run" }} />
      <Stack.Screen name="agents/new" options={{ title: "New assignment" }} />
      <Stack.Screen name="agents/settings" options={{ title: "Execution settings" }} />
      <Stack.Screen name="meetings/[rec]" options={{ title: "Meeting" }} />
      <Stack.Screen name="meetings/instructions" options={{ title: "Reading instructions" }} />
      <Stack.Screen name="connections" options={{ title: "Connections" }} />
      <Stack.Screen name="issues" options={{ title: "Diagnostics" }} />
      <Stack.Screen name="settings" options={{ title: "Phone connection" }} />
      <Stack.Screen name="cleanup" options={{ title: "Clean up" }} />
      <Stack.Screen name="voice" options={{ title: "Talk to DAVE" }} />
    </Stack.Protected>
    <Stack.Screen name="pair" options={{ headerShown: false, presentation: paired ? "modal" : "card" }} />
  </Stack>;
  // One voice session for the whole paired app, so it survives navigation.
  if (!paired) return stack;
  return <VoiceProvider>{stack}<VoiceDock /></VoiceProvider>;
}
