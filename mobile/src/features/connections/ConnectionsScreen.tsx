import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { ArrowRight, Ban, RefreshCw, Smartphone } from "lucide-react-native";
import { useResource } from "../../lib/useResource";
import { Banner, Button, Caption, Inline, Muted, Panel, Row, Screen, Small } from "../../ui/primitives";
import { StatusMark } from "../../ui/status";
import { FathomCard } from "./FathomCard";
import { OpenAICard, providerMark, type ProviderStatus } from "./OpenAICard";

/**
 * Connections on the phone: OpenAI, Fathom and the Claude status, same text as
 * the web. Phone pairing itself is managed on the Mac only.
 */
export function ConnectionsScreen() {
  const router = useRouter();
  // Poll every 2 s only while a browser sign-in is pending on the Mac.
  const [pending, setPending] = useState(false);
  const providers = useResource<ProviderStatus>("/api/providers", { pollMs: pending ? 2000 : undefined });
  const status = providers.data;
  useEffect(() => setPending(status?.operation?.status === "pending"), [status]);

  return <Screen refreshing={providers.refreshing} onRefresh={() => void providers.reload()}>
    <Panel title="Connection summary" actions={<Button title="Reload" icon={RefreshCw} variant="subtle" compact accessibilityLabel="Reload connection status" disabled={providers.refreshing} onPress={() => void providers.reload()} />}>
      {status && <Inline gap={12}>
        <StatusMark spec={providerMark(status.openai.state)}>OpenAI</StatusMark>
        <StatusMark spec={{ tone: "gray", icon: Ban, label: "" }}>Claude unavailable</StatusMark>
      </Inline>}
      <Muted>Planning sends only your explicitly previewed and approved project packet to the selected provider. Subscription and model access depend on your account. Dave never switches model, provider or billing method silently.</Muted>
      {providers.error ? <Banner tone="red" title="Connection action needs attention" message={providers.error} /> : null}
    </Panel>
    <OpenAICard status={status} reload={providers.reload} />
    <FathomCard />
    <Panel padded={false}>
      <Row title="Phone pairing is managed on your Mac" subtitle="Turn phone access on or off, or pair a new phone, in DAVE on the Mac. This phone's own connection settings are here."
        spec={{ tone: "gray", icon: Smartphone, label: "" }} onPress={() => router.push("/settings")} />
    </Panel>
    <Panel title="Anthropic / Claude subscription" spec={{ tone: "gray", icon: Ban, label: "" }} note={`Status: ${status?.claude.state ?? "loading"}`}>
      <Muted>Requested models: claude-fable-5-1, claude-opus-5.</Muted>
      <Small>{status?.claude.error ?? "Claude remains unavailable until verified official-runtime isolation is supported."}</Small>
      <Caption>No Claude login or inference is started here. No Anthropic API-key fallback. Credentials and subscription billing remain owned by the official Claude application.</Caption>
    </Panel>
    <Button title="Choose project goal and planning model" icon={ArrowRight} variant="subtle" onPress={() => router.push("/projects")} />
  </Screen>;
}
