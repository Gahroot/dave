import { List, Stack, Text } from "@mantine/core";
import type { Disclosure } from "../../meetings/types.ts";

/** Renders the server's exact disclosure text; consent is tied to this wording. */
export function MeetingDisclosure({ disclosure }: { disclosure: Disclosure }) {
  return <Stack gap="sm">
    {disclosure.sections.map(section => <div key={section.title}>
      <Text fw={600} size="sm">{section.title}:</Text>
      <List size="sm" spacing={4}>{section.items.map(item => <List.Item key={item}>{item}</List.Item>)}</List>
    </div>)}
    {disclosure.notes.map(note => <Text key={note} size="sm">{note}</Text>)}
  </Stack>;
}
