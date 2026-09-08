import { useState } from "react";
import { Button, Stack, Text, Textarea } from "@mantine/core";

export function CopyText({ text, label }: { text: string; label: string }) {
  const [failed, setFailed] = useState(false);
  const [message, setMessage] = useState("");
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setFailed(false); setMessage("Copied."); }
    catch { setFailed(true); setMessage("Clipboard unavailable. Select and copy the text below."); }
  };
  return <Stack gap={4} style={{ minWidth: 0, maxWidth: "100%" }}>
    <Button variant="default" onClick={() => void copy()}>{label}</Button>
    <Text size="xs" role="status">{message}</Text>
    {failed && <Textarea label={`${label}: selectable text`} readOnly value={text} autosize minRows={2} maxRows={8} onFocus={(e) => e.currentTarget.select()} />}
  </Stack>;
}
