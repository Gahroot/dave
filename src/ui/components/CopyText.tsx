import { useState } from "react";
import { Button, Stack, Text, Textarea, type ButtonProps } from "@mantine/core";

/**
 * Copies text to the clipboard. `onCopied` runs only after a successful copy (copying is sending).
 * When the clipboard fails, the text is shown selectable and, if `onMarkSent` is given, a "Mark as sent" button
 * lets the owner record it after copying by hand.
 */
export function CopyText({ text, label, onCopied, onMarkSent, disabled, loading, size, variant = "default", leftSection }: {
  text: string; label: string; onCopied?: () => void; onMarkSent?: () => void; disabled?: boolean; loading?: boolean;
  size?: ButtonProps["size"]; variant?: ButtonProps["variant"]; leftSection?: ButtonProps["leftSection"];
}) {
  const [failed, setFailed] = useState(false);
  const [message, setMessage] = useState("");
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); }
    catch { setFailed(true); setMessage("Clipboard unavailable. Select and copy the text below."); return; }
    setFailed(false); setMessage("Copied.");
    onCopied?.();
  };
  return <Stack gap={4} style={{ minWidth: 0, maxWidth: "100%" }}>
    <Button variant={variant} size={size} disabled={disabled} loading={loading} leftSection={leftSection} onClick={() => void copy()}>{label}</Button>
    <Text size="xs" role="status">{message}</Text>
    {failed && <Textarea label={`${label}: selectable text`} readOnly value={text} autosize minRows={2} maxRows={8} onFocus={(e) => e.currentTarget.select()} />}
    {failed && onMarkSent && <Button variant="light" size={size} disabled={disabled} loading={loading} onClick={onMarkSent}>Mark as sent</Button>}
  </Stack>;
}
