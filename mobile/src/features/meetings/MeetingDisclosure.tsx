import { useState, type ReactNode } from "react";
import { Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import type { Disclosure } from "../../../../src/meetings/types.ts";
import { Banner, BottomSpacer, Button, Inline, Stack, Toggle } from "../../ui/primitives";
import { colors, radius, space, text } from "../../ui/theme";

/** Renders the server's exact disclosure text; consent is tied to this wording. */
export function MeetingDisclosure({ disclosure }: { disclosure: Disclosure }) {
  return <Stack gap={space.sm}>
    {disclosure.sections.map((section) => <View key={section.title} style={styles.section}>
      <Text style={[text.small, styles.bold]}>{section.title}:</Text>
      {section.items.map((item) => <View key={item} style={styles.bullet}><Text style={text.small}>•</Text><Text style={[text.small, styles.flex]}>{item}</Text></View>)}
    </View>)}
    {disclosure.notes.map((note) => <Text key={note} style={text.small}>{note}</Text>)}
  </Stack>;
}

/**
 * The web's consent modal as a sheet: the exact disclosure, an explicit
 * agreement switch, and the confirm button disabled until agreed.
 */
export function ConsentSheet({ visible, title, intro, disclosure, agreeLabel, confirmLabel, cancelLabel = "Cancel", busy, warning, onCancel, onConfirm }: {
  visible: boolean; title: string; intro?: string; disclosure: Disclosure; agreeLabel: string; confirmLabel: string; cancelLabel?: string;
  busy: boolean; warning?: ReactNode; onCancel: () => void; onConfirm: () => void;
}) {
  const [agreed, setAgreed] = useState(false);
  const close = () => { setAgreed(false); onCancel(); };
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
    <ScrollView style={styles.sheet} contentContainerStyle={styles.content}>
      <Text style={text.heading} accessibilityRole="header">{title}</Text>
      {intro && <Text style={text.small}>{intro}</Text>}
      <View style={styles.box}><MeetingDisclosure disclosure={disclosure} /></View>
      {warning}
      <Toggle label={agreeLabel} value={agreed} onValueChange={setAgreed} disabled={busy} />
      <Inline>
        <Button title={cancelLabel} onPress={close} />
        <Button title={confirmLabel} variant="primary" disabled={!agreed} loading={busy} onPress={() => { onConfirm(); setAgreed(false); }} />
      </Inline>
      <BottomSpacer />
    </ScrollView>
  </Modal>;
}

export function OpenAIMissing() {
  return <Banner tone="amber" title="OpenAI is not connected" message="Connect or restore OpenAI above. Until then, nothing is sent even with analysis on." />;
}

const styles = StyleSheet.create({
  section: { gap: space.xxs },
  bullet: { flexDirection: "row", gap: space.sm, paddingLeft: space.xs },
  flex: { flex: 1 },
  bold: { fontWeight: "600" },
  sheet: { flex: 1, backgroundColor: colors.surface },
  content: { padding: space.lg, gap: space.md },
  box: { backgroundColor: colors.sunken, borderRadius: radius.md, padding: space.md },
});
