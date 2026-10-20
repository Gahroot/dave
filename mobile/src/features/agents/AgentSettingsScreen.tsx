/** Execution settings (web AgentPlatform RuntimeSettings). POST /api/agents/settings. */
import { useEffect, useRef, useState } from "react";
import { Save, TriangleAlert } from "lucide-react-native";
import type { AgentOverview, AgentSettings } from "../../../../src/agents/types.ts";
import { describeError } from "../../lib/api";
import { useApi } from "../../lib/connection";
import { useResource } from "../../lib/useResource";
import { Banner, Button, ErrorState, LoadingState, Panel, Screen, TextField, Toggle, BottomSpacer, tick } from "../../ui/primitives";
import { StatusMark } from "../../ui/status";
import { Checkbox, EXECUTION, useDraftGuard } from "./components";
import { LIMITS, executionState, type SettingsDraft } from "./model";

const toDraft = (s: AgentSettings): SettingsDraft => ({ maxConcurrent: String(s.maxConcurrent), maxPerProject: String(s.maxPerProject), reviewLimit: String(s.reviewLimit), timeoutMinutes: String(s.timeoutMinutes) });

export function AgentSettingsScreen() {
  const { data, error, loading, refreshing, reload, setData } = useResource<AgentOverview>("/api/agents");
  if (!data) return <Screen onRefresh={() => void reload()} refreshing={refreshing}>
    {error ? <ErrorState message={`${error} Last loaded state may be out of date.`} title="Connection unavailable" onRetry={() => void reload()} /> : loading ? <LoadingState label="Loading runs…" /> : null}
  </Screen>;
  return <SettingsForm initial={data.settings} error={error} onSaved={(settings) => setData((d) => d ? { ...d, settings } : d)} />;
}

function SettingsForm({ initial, error: loadError, onSaved }: { initial: AgentSettings; error: string | null; onSaved: (s: AgentSettings) => void }) {
  const api = useApi();
  const [saved, setSaved] = useState(initial);
  const [enabled, setEnabled] = useState(initial.enabled), [paused, setPaused] = useState(initial.paused);
  const [limits, setLimits] = useState<SettingsDraft>(toDraft(initial));
  const [ack, setAck] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const lock = useRef(false);
  const value: AgentSettings = { enabled, paused, maxConcurrent: Number(limits.maxConcurrent), maxPerProject: Number(limits.maxPerProject), reviewLimit: Number(limits.reviewLimit), timeoutMinutes: Number(limits.timeoutMinutes) };
  const dirty = JSON.stringify(value) !== JSON.stringify(saved);
  useDraftGuard(dirty);
  useEffect(() => { if (!dirty) setError(""); }, [dirty]);
  const state = executionState(saved);

  const save = async () => {
    if (lock.current) return; lock.current = true; setBusy(true); setError("");
    try {
      const s = await api.post<AgentSettings>("/api/agents/settings", { ...value, acknowledgeRisk: ack });
      setSaved(s); setEnabled(s.enabled); setPaused(s.paused); setLimits(toDraft(s)); setAck(false); onSaved(s); tick();
    } catch (e) { setError(describeError(e, "Request failed. Your draft is retained.")); } finally { setBusy(false); lock.current = false; }
  };

  return <Screen>
    {loadError && <Banner tone="red" title="Connection unavailable" message={`${loadError} Last loaded state may be out of date.`} />}
    <Panel title="Limits and permissions" spec={EXECUTION[state]} note={<StatusMark spec={EXECUTION[state]}>{`Execution ${state}`}</StatusMark>}>
      <Banner tone="amber" title="Runs use your local agent account" message="Agents and approved checks can execute commands and access your machine and network. They may incur provider charges. A worktree separates files, not permissions. EZCoder currently runs without approval prompts. No automatic commits, merges, deployments or workspace deletion are performed by DAVE." />
      {error && <Banner tone="red" title="Not saved" message={error} />}
      <Toggle label="Enable local agent execution" value={enabled} onValueChange={setEnabled} />
      <Toggle label="Pause new starts (running work continues)" value={paused} onValueChange={setPaused} />
      {LIMITS.map(([key, label, max]) => <TextField key={key} label={label} help={`1 to ${max}`} keyboardType="number-pad" value={limits[key]}
        onChangeText={(v) => setLimits((l) => ({ ...l, [key]: v.replace(/[^0-9]/g, "") }))} />)}
      {!saved.enabled && <Checkbox label="I understand these agents are not sandboxed and may use my paid account" checked={ack} onChange={setAck} />}
      <Button variant="primary" icon={enabled && !saved.enabled ? TriangleAlert : Save} title="Save execution settings" loading={busy} disabled={enabled && !saved.enabled && !ack} onPress={() => void save()} />
    </Panel>
    <BottomSpacer />
  </Screen>;
}
