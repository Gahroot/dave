import os from "node:os";
import QRCode from "qrcode";
import type { FastifyInstance } from "fastify";
import {
  DEFAULT_MOBILE_PORT, MAX_OFFER_HOSTS, cleanDisplayName, fromHex, pairingLink, randomRootKey, roomId, secureRandom, toHex,
  type RandomBytes,
} from "./protocol.ts";
import { startGateway, type GatewayPairing, type RunningGateway } from "./gateway.ts";
import { pairingStore, type PairingRecord, type PairingStore } from "./pairing-store.ts";
import type { MobileSettings } from "./settings.ts";

export type MobilePairingStatus = {
  enabled: boolean;
  listening: boolean;
  port: number;
  hosts: string[];
  name: string;
  paired: boolean;
  device: string | null;
  claimedAt: string | null;
  createdAt: string | null;
  link: string | null;
  qrSvg: string | null;
  error: string | null;
};

export type MobileServiceOptions = {
  store?: PairingStore;
  port?: number;
  /** Listen address; LAN-wide by default. Tests bind 127.0.0.1. */
  listenHost?: string;
  hosts?: () => string[];
  hostname?: () => string;
  now?: () => Date;
  random?: RandomBytes;
};

type Interfaces = ReturnType<typeof os.networkInterfaces>;
const HOSTNAME = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,62})(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,62}))*$/;

function interfaceRank(name: string): number {
  if (/^(en|eth|wl)/.test(name)) return 0;
  if (/^(bridge|docker|utun|tun|tap|veth|vboxnet|vmnet)/.test(name)) return 2;
  return 1;
}

/** Advertised LAN addresses, best first: real interfaces, then others, then virtual ones, then the hostname. */
export function lanHosts(interfaces: Interfaces, hostname: string): string[] {
  const found: { name: string; address: string }[] = [];
  for (const name of Object.keys(interfaces).sort()) {
    for (const info of interfaces[name] ?? []) {
      if (info.family !== "IPv4" || info.internal || info.address.startsWith("169.254.")) continue;
      found.push({ name, address: info.address });
    }
  }
  found.sort((a, b) => interfaceRank(a.name) - interfaceRank(b.name));
  const hosts = found.map((entry) => entry.address);
  const trimmed = hostname.trim();
  if (trimmed.length > 0 && trimmed.length <= 253 && HOSTNAME.test(trimmed)) hosts.push(trimmed.includes(".") ? trimmed : `${trimmed}.local`);
  return [...new Set(hosts)].slice(0, MAX_OFFER_HOSTS);
}

const errorText = (error: unknown, fallback: string): string => {
  if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EADDRINUSE") {
    return "The phone access port is already in use by another app. Free it or set PCC_MOBILE_PORT, then turn phone access on again.";
  }
  if (error instanceof Error && error.message === "Secure storage unavailable") return "Secure storage (macOS Keychain) is unavailable, so phone access cannot be used.";
  return fallback;
};

export type MobileService = ReturnType<typeof createMobileService>;

/**
 * Opt-in phone access. The LAN listener is started only when `allowListen` is
 * true (server entry point or an explicit test) and the operator enabled it.
 */
export function createMobileService(app: FastifyInstance, origin: string, settings: MobileSettings, options: MobileServiceOptions & { allowListen?: boolean } = {}) {
  const store = options.store ?? pairingStore();
  const configuredPort = options.port ?? (Number(process.env.PCC_MOBILE_PORT) || DEFAULT_MOBILE_PORT);
  const now = options.now ?? (() => new Date());
  const random = options.random ?? secureRandom;
  const hostname = options.hostname ?? os.hostname;
  const hosts = options.hosts ?? (() => lanHosts(os.networkInterfaces(), hostname()));
  const startedAt = now().getTime();
  let record: PairingRecord | null = null;
  let current: GatewayPairing | null = null;
  let running: RunningGateway | undefined;
  let error: string | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const setRecord = (next: PairingRecord | null) => {
    record = next;
    if (!next) { current = null; return; }
    const key = fromHex(next.key);
    current = { key, room: roomId(key), claimedBy: next.claimedBy ?? null };
  };
  const mint = (): PairingRecord => ({ v: 1, key: toHex(randomRootKey(random)), createdAt: now().toISOString() });
  const name = () => cleanDisplayName(hostname());

  const claim = (deviceId: string) => {
    if (!record || record.claimedBy) return;
    const claimed: PairingRecord = { ...record, claimedBy: deviceId, claimedAt: now().toISOString() };
    setRecord(claimed);
    try { store.write(claimed); error = null; }
    catch (e) { error = errorText(e, "The phone paired, but DAVE could not save the pairing. It will be lost when DAVE restarts."); }
  };

  const listen = async () => {
    if (running || !options.allowListen || !current) return;
    running = await startGateway({
      app, origin, pairing: () => current, claim, name, port: configuredPort, host: options.listenHost ?? "0.0.0.0",
      now: () => now().getTime(), startedAt, random,
    });
  };
  const stop = async () => {
    const gateway = running;
    running = undefined;
    if (gateway) await gateway.close();
  };

  /** Serialises operations so enable/disable/rotate never interleave. */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  const status = async (): Promise<MobilePairingStatus> => {
    const enabled = settings.enabled();
    const listening = !!running;
    const advertised = hosts();
    const offer = enabled && listening && record && !record.claimedBy && advertised.length > 0
      ? pairingLink({ hosts: advertised, port: running?.port ?? configuredPort, room: current?.room ?? "", name: name(), key: record.key })
      : null;
    return {
      enabled, listening, port: running?.port ?? configuredPort, hosts: advertised, name: name(),
      paired: !!record?.claimedBy,
      device: record?.claimedBy ? `${record.claimedBy.slice(0, 14)}…` : null,
      claimedAt: record?.claimedAt ?? null,
      createdAt: record?.createdAt ?? null,
      link: offer,
      qrSvg: offer ? await QRCode.toString(offer, { type: "svg", errorCorrectionLevel: "M", margin: 2 }) : null,
      error: error ?? (enabled && listening && advertised.length === 0 ? "No local network address found. Connect your Mac to Wi-Fi or Ethernet." : null),
    };
  };

  const loadOrMint = (): void => {
    if (record) return;
    const saved = store.read();
    if (saved) { setRecord(saved); return; }
    const fresh = mint();
    store.write(fresh);
    setRecord(fresh);
  };

  return {
    status,
    /** Boot: reads the Keychain only when phone access was switched on. */
    start: () => serial(async () => {
      if (!settings.enabled()) return;
      try { loadOrMint(); await listen(); error = null; }
      catch (e) { error = errorText(e, "Phone access could not start."); }
    }),
    enable: () => serial(async () => {
      try {
        loadOrMint();
        settings.setEnabled(true);
        await listen();
        error = null;
      } catch (e) { error = errorText(e, "Phone access could not be turned on."); }
      return status();
    }),
    disable: () => serial(async () => {
      settings.setEnabled(false);
      try { await stop(); error = null; } catch { error = "The phone listener did not stop cleanly."; }
      return status();
    }),
    rotate: () => serial(async () => {
      try {
        const fresh = mint();
        store.write(fresh);
        // Swapping the in-memory pairing refuses the old key on the very next request.
        setRecord(fresh);
        error = null;
      } catch (e) { error = errorText(e, "A new pairing code could not be saved."); }
      return status();
    }),
    forget: () => serial(async () => {
      settings.setEnabled(false);
      try { await stop(); } catch { /* still forget */ }
      setRecord(null);
      try { store.delete(); error = null; } catch (e) { error = errorText(e, "The pairing could not be removed from the Keychain."); }
      return status();
    }),
    close: () => serial(stop),
  };
}
