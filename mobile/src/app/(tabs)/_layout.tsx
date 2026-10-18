import { Tabs } from "expo-router";
import { Folder, Handshake, Inbox, Menu, Target } from "lucide-react-native";
import { ConnectionBanner } from "../../features/pairing/ConnectionBanner";
import { colors } from "../../ui/theme";

/** Primary navigation mirrors the web rail: Focus, Inbox, Projects, Meetings; the rest lives under More. */
export default function TabsLayout() {
  return <>
    <ConnectionBanner />
    <Tabs screenOptions={{
      tabBarActiveTintColor: colors.accent,
      tabBarInactiveTintColor: colors.muted,
      headerTitleStyle: { color: colors.ink, fontWeight: "600" },
      headerShadowVisible: false,
      sceneStyle: { backgroundColor: colors.canvas },
    }}>
      <Tabs.Screen name="index" options={{ title: "Focus", tabBarIcon: ({ color, size }) => <Target color={color} size={size} /> }} />
      <Tabs.Screen name="queue" options={{ title: "Inbox", tabBarIcon: ({ color, size }) => <Inbox color={color} size={size} /> }} />
      <Tabs.Screen name="projects" options={{ title: "Projects", tabBarIcon: ({ color, size }) => <Folder color={color} size={size} /> }} />
      <Tabs.Screen name="meetings" options={{ title: "Meetings", tabBarIcon: ({ color, size }) => <Handshake color={color} size={size} /> }} />
      <Tabs.Screen name="more" options={{ title: "More", tabBarIcon: ({ color, size }) => <Menu color={color} size={size} /> }} />
    </Tabs>
  </>;
}
