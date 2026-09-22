import { useEffect, useState } from "react";
import type { AgentOverview } from "../../agents/types.ts";
import { deliveryApi } from "../delivery-api.ts";
import type { DeliveryQueueData } from "../inbox-model.ts";

/** Shared source owner; agent cadence and delivery-on-selection reads match the previous queues. */
export function useInboxData(paused: boolean, selection: string | null) {
  const [agents, setAgents] = useState<AgentOverview | null>(null);
  const [delivery, setDelivery] = useState<DeliveryQueueData | null>(null);
  const [errors, setErrors] = useState({ agents: "", delivery: "" });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const ac = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try { if (document.visibilityState === "visible") { const value = await deliveryApi<AgentOverview>("/api/agents", undefined, ac.signal); if (!ac.signal.aborted) { setAgents(value); setErrors(old => ({ ...old, agents: "" })); } } }
      catch { if (!ac.signal.aborted) setErrors(old => ({ ...old, agents: "Agent state could not be refreshed." })); }
      finally { if (!ac.signal.aborted && !paused) timer = setTimeout(load, 10000); }
    };
    void load(); return () => { ac.abort(); clearTimeout(timer); };
  }, [paused, revision]);
  useEffect(() => {
    const ac = new AbortController();
    void deliveryApi<DeliveryQueueData>("/api/delivery/queue", undefined, ac.signal).then(value => { if (!ac.signal.aborted) { setDelivery(value); setErrors(old => ({ ...old, delivery: "" })); } }).catch(() => { if (!ac.signal.aborted) setErrors(old => ({ ...old, delivery: "Delivery state could not be refreshed." })); });
    return () => ac.abort();
  }, [selection, revision]);
  return { agents, delivery, errors, retry: () => setRevision(value => value + 1) };
}
