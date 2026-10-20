/**
 * More: the paired Mac, the secondary destinations from the web rail, and a
 * full project rescan (the web's refresh, POST /api/refresh).
 */
import { useEffect, useRef, useState } from "react";
import { router, type Href } from "expo-router";
import { Activity, AudioLines, Bot, Eraser, Plug, RefreshCw, Smartphone, type LucideIcon } from "lucide-react-native";
import type { Portfolio } from "../../../../src/shared/types.ts";
import { relative } from "../../../../src/ui/format.ts";
import { CONNECTION } from "../../../../src/ui/status.ts";
import { describeError } from "../../lib/api";
import { useApi, useConnection } from "../../lib/connection";
import { Banner, Button, Caption, Divider, Panel, Row, Screen, Stack, tick } from "../../ui/primitives";
import { colors, space } from "../../ui/theme";
import { problemTitle } from "./ConnectionBanner";
import { useCleanupCount } from "../cleanup/useCleanupCount";
import { CountPill } from "../../ui/status";

type Destination = { title: string; subtitle: string; href: Href; icon: LucideIcon };
const DESTINATIONS: readonly Destination[] = [
  { title: "Talk to DAVE", subtitle: "Ask about your work and act on it by voice", href: "/voice", icon: AudioLines },
  { title: "Clean up", subtitle: "Clear or close stale promises and drafted decisions in bulk", href: "/cleanup", icon: Eraser },
  { title: "Agent desk", subtitle: "Runs, assignments and agent settings", href: "/agents", icon: Bot },
  { title: "Connections", subtitle: "Providers, keys and integrations", href: "/connections", icon: Plug },
  { title: "Diagnostics", subtitle: "Scan issues and source health", href: "/issues", icon: Activity },
  { title: "Phone connection", subtitle: "This phone's pairing with your Mac", href: "/settings", icon: Smartphone },
];

export function MoreScreen() {
  const { state, problem } = useConnection();
  const api = useApi();
  const cleanupCount = useCleanupCount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const rescan = async () => {
    if (busy) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true); setError(null);
    try {
      const portfolio = await api.post<Portfolio>("/api/refresh", {}, { timeoutMs: 120_000, signal: controller.signal });
      setUpdated(portfolio.generatedAt);
      tick();
    } catch (e) {
      if (!controller.signal.aborted) setError(describeError(e));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const name = state.status === "ready" ? state.name : "your Mac";
  const spec = problem ? { ...CONNECTION.error, label: problemTitle(problem.kind) } : CONNECTION.connected;
  return <Screen>
    <Panel title={name} spec={spec} note={problem ? problemTitle(problem.kind) : "Paired Mac"} padded={false}>
      {DESTINATIONS.map((d, i) => <Stack key={d.title} gap={0}>
        {i > 0 && <Divider />}
        <Row title={d.title} subtitle={d.subtitle} onPress={() => router.push(d.href)}
          accessibilityLabel={d.href === "/cleanup" && cleanupCount ? `${d.title}, ${cleanupCount === 1 ? "1 item" : `${cleanupCount} items`} to clean up` : d.title}
          right={<>{d.href === "/cleanup" && cleanupCount ? <CountPill value={cleanupCount} /> : null}<d.icon size={18} color={colors.muted} /></>} />
      </Stack>)}
    </Panel>
    <Panel title="Rescan projects" note="Reads every project folder on your Mac again. Can take a minute or two.">
      <Stack gap={space.sm}>
        {error && <Banner tone="red" title="Rescan failed" message={error} />}
        <Button variant="primary" title={busy ? "Rescanning…" : "Rescan projects"} icon={RefreshCw} loading={busy} onPress={() => void rescan()} />
        {updated && !busy && <Caption>{`Updated ${relative(updated)}`}</Caption>}
      </Stack>
    </Panel>
  </Screen>;
}
