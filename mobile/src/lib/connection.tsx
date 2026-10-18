/**
 * Who this phone is paired with, and the API client that talks to it.
 *
 *   const { state } = useConnection();   // loading | unpaired | ready
 *   const api = useApi();                // throws outside a ready connection
 *
 * A stored pairing is trusted immediately on launch (no network wait); a
 * background `hello` then picks the address that answers. Connection problems
 * surface as `problem` for the shared banner instead of unpairing on their own:
 * only the user unpairs.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PairingOffer } from "../../../src/mobile/protocol.ts";
import { createApi, type Api } from "./api";
import { clearPairing, loadDeviceId, loadPairing, savePairing, savePreferredHost } from "./pairing-storage";
import { call, hello, MESSAGES, TransportError, upload } from "./transport";

export type ConnectionState =
  | { status: "loading" }
  | { status: "unpaired" }
  | { status: "ready"; offer: PairingOffer; deviceId: string; host: string; name: string };

export type ConnectionProblem = { kind: TransportError["kind"]; message: string; at: number };
export type PairResult = { ok: true; name: string } | { ok: false; message: string };

type ConnectionValue = {
  state: ConnectionState;
  /** Last transport failure, cleared by the next successful exchange. */
  problem: ConnectionProblem | null;
  /** Verify a scanned offer with a real sealed `hello` (claims the pairing), then store it. */
  pair(offer: PairingOffer): Promise<PairResult>;
  /** Re-run `hello` to pick a reachable address and refresh `problem`. */
  recheck(): Promise<void>;
  /** Forget the Mac on this phone. Does not change anything on the Mac. */
  unpair(): Promise<void>;
  api: Api | null;
};

const Context = createContext<ConnectionValue | null>(null);

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConnectionState>({ status: "loading" });
  const [problem, setProblem] = useState<ConnectionProblem | null>(null);
  const live = useRef<ConnectionState>(state);
  live.current = state;

  const note = useCallback((error: unknown) => {
    if (error instanceof TransportError) setProblem({ kind: error.kind, message: error.message, at: Date.now() });
  }, []);

  const useHost = useCallback((host: string) => {
    setState((current) => current.status === "ready" && current.host !== host ? { ...current, host } : current);
    void savePreferredHost(host).catch(() => undefined);
  }, []);

  const recheck = useCallback(async () => {
    const current = live.current;
    if (current.status !== "ready") return;
    try {
      const answer = await hello(current.offer, current.deviceId, current.host);
      setState((s) => s.status === "ready" ? { ...s, host: answer.host, name: answer.body.name } : s);
      void savePreferredHost(answer.host).catch(() => undefined);
      setProblem(null);
    } catch (error) { note(error); }
  }, [note]);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const [stored, deviceId] = await Promise.all([loadPairing(), loadDeviceId()]);
        if (disposed) return;
        if (!stored || !stored.preferredHost) { setState({ status: "unpaired" }); return; }
        setState({ status: "ready", offer: stored.offer, deviceId, host: stored.preferredHost, name: stored.offer.name });
      } catch {
        // A locked or unavailable keychain shows the pairing screen rather than crashing.
        if (!disposed) setState({ status: "unpaired" });
      }
    })();
    return () => { disposed = true; };
  }, []);

  const readyKey = state.status === "ready" ? `${state.offer.room}|${state.deviceId}` : null;
  useEffect(() => { if (readyKey) void recheck(); }, [readyKey, recheck]);

  const pair = useCallback(async (offer: PairingOffer): Promise<PairResult> => {
    try {
      const deviceId = await loadDeviceId();
      const answer = await hello(offer, deviceId);
      await savePairing(offer, answer.host);
      setProblem(null);
      setState({ status: "ready", offer, deviceId, host: answer.host, name: answer.body.name });
      return { ok: true, name: answer.body.name };
    } catch (error) {
      if (error instanceof TransportError) return { ok: false, message: error.message };
      return { ok: false, message: "This phone could not store the pairing securely. Check device passcode settings, then retry." };
    }
  }, []);

  const unpair = useCallback(async () => {
    await clearPairing().catch(() => undefined);
    setProblem(null);
    setState({ status: "unpaired" });
  }, []);

  // Rebuilt only when the pairing itself changes (readyKey); each call reads the
  // current pairing and address from `live`, so a host switch never goes stale.
  const api = useMemo<Api | null>(() => {
    if (readyKey === null) return null;
    const endpoint = () => {
      const current = live.current;
      if (current.status !== "ready") throw new TransportError("unpaired", MESSAGES.unpaired);
      return { offer: current.offer, deviceId: current.deviceId, host: current.host };
    };
    return createApi(async (method, path, body, options) => {
      const target = endpoint();
      try {
        const result = await call(target, method, path, body, options);
        if (result.host !== target.host) useHost(result.host);
        setProblem(null);
        return result;
      } catch (error) { note(error); throw error; }
    }, async (file, options) => {
      try {
        const result = await upload(endpoint(), file, options);
        setProblem(null);
        return result;
      } catch (error) { note(error); throw error; }
    });
  }, [readyKey, note, useHost]);

  const value = useMemo<ConnectionValue>(() => ({ state, problem, pair, recheck, unpair, api }), [state, problem, pair, recheck, unpair, api]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useConnection(): ConnectionValue {
  const value = useContext(Context);
  if (!value) throw new Error("useConnection must be used inside <ConnectionProvider>");
  return value;
}

/** The API client for screens behind the paired layout. */
export function useApi(): Api {
  const { api } = useConnection();
  if (!api) throw new Error(MESSAGES.unpaired);
  return api;
}
