/** Unconfirmed noise with the default filter (POST /api/triage/preview {filter:{}} → total), like the web's nav pill. null while unknown or on failure. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import type { TriagePreview } from "../../../../src/triage/types.ts";
import { useApi } from "../../lib/connection";
import { onDataChanged } from "../../lib/data-events";

export function useCleanupCount(): number | null {
  const api = useApi();
  const [count, setCount] = useState<number | null>(null);
  const seq = useRef(0);
  const recount = useCallback(() => {
    const mine = ++seq.current;
    api.post<TriagePreview>("/api/triage/preview", { filter: {} }, { timeoutMs: 30_000 })
      .then((r) => { if (mine === seq.current) setCount(typeof r.total === "number" ? r.total : null); })
      .catch(() => { if (mine === seq.current) setCount(null); });
  }, [api]);
  useFocusEffect(useCallback(() => { recount(); }, [recount]));
  useEffect(() => onDataChanged((scopes) => { if (scopes.includes("meetings") || scopes.includes("intel")) recount(); }), [recount]);
  return count;
}
