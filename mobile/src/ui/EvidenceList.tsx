/** Shows exactly what was read to produce an inference — never the whole file. Mirrors src/ui/components/EvidenceList.tsx. */
import { StyleSheet, Text, View } from "react-native";
import type { EvidenceRef } from "../../../src/shared/types.ts";
import { space, text } from "./theme";

export function EvidenceList({ evidence }: { evidence: readonly EvidenceRef[] }) {
  if (evidence.length === 0) return <Text style={[text.caption, styles.italic]}>No evidence recorded</Text>;
  return <View style={styles.list} accessibilityRole="list">
    {evidence.map((e, i) => <Text key={`${e.kind}-${i}`} style={text.caption} selectable>
      <Text style={styles.bold}>{e.kind}</Text> — {e.detail}{e.path ? `\n${e.path}` : ""}
    </Text>)}
  </View>;
}

const styles = StyleSheet.create({
  list: { gap: space.xs },
  bold: { fontWeight: "600" },
  italic: { fontStyle: "italic" },
});
