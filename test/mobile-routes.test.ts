import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server/index.ts";
import { sourcePaths } from "../src/shared/paths.ts";
import { memoryKeyStore } from "../src/meetings/credentials.ts";
import { memoryPairingStore, pairingStore, parsePairingRecord, type PairingStore } from "../src/mobile/pairing-store.ts";
import { lanHosts } from "../src/mobile/service.ts";
import type { SecretEntry } from "../src/meetings/credentials.ts";
import { tempDir } from "./helpers.ts";

const apps: FastifyInstance[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});
const headers = { host: "localhost:4317", origin: "http://localhost:4317" };
const KEYS = ["claimedAt", "createdAt", "device", "enabled", "error", "hosts", "link", "listening", "name", "paired", "port", "qrSvg"];

async function fixture(options: { store?: PairingStore; listen?: boolean; home?: string } = {}) {
  const home = options.home ?? tempDir("mobile-routes-");
  if (!options.home) homes.push(home);
  const store = options.store ?? memoryPairingStore();
  const app = await buildServer(sourcePaths(home, home), {
    meetings: { keyStore: memoryKeyStore(), openAIConnected: () => false, inference: async () => "{}" },
    mobile: { store, port: 0, listenHost: "127.0.0.1", hosts: () => ["192.168.1.20", "test-mac.local"], hostname: () => "Test Mac" },
    startMobileGateway: options.listen ?? true,
  });
  apps.push(app);
  await app.ready();
  const token = (await app.inject({ url: "/api/security/csrf", headers })).json().token as string;
  return {
    app, store, home,
    status: async () => (await app.inject({ url: "/api/mobile/pairing", headers })).json(),
    post: async (action: string) => app.inject({ method: "POST", url: `/api/mobile/pairing/${action}`, headers: { ...headers, "x-dave-csrf": token }, payload: {} }),
  };
}

describe("mobile pairing routes", () => {
  it("reports off without touching the store, then enable mints a pairing with a link and QR", async () => {
    let reads = 0;
    const inner = memoryPairingStore();
    const store: PairingStore = { read: () => { reads++; return inner.read(); }, write: r => inner.write(r), delete: () => inner.delete() };
    const fx = await fixture({ store });
    const off = await fx.status();
    expect(Object.keys(off).sort()).toEqual(KEYS);
    expect(off).toMatchObject({ enabled: false, listening: false, paired: false, link: null, qrSvg: null, error: null, name: "Test Mac" });
    expect(reads).toBe(0);
    const on = (await fx.post("enable")).json();
    expect(on).toMatchObject({ enabled: true, listening: true, paired: false, hosts: ["192.168.1.20", "test-mac.local"] });
    expect(on.port).toBeGreaterThan(0);
    expect(on.link).toMatch(/^dave:\/\/pair\?v=1&h=192\.168\.1\.20,test-mac\.local&p=\d+&r=[0-9a-f]{48}&n=Test%20Mac#k=/);
    expect(on.qrSvg).toContain("<svg");
    expect(fx.store.read()?.key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hides the link once claimed, rotates, disables and forgets", async () => {
    const createdAt = "2026-10-01T00:00:00.000Z";
    const store = memoryPairingStore({ v: 1, key: "a".repeat(64), createdAt, claimedBy: `phone-${"b".repeat(32)}`, claimedAt: createdAt });
    const fx = await fixture({ store });
    const on = (await fx.post("enable")).json();
    expect(on).toMatchObject({ enabled: true, listening: true, paired: true, link: null, qrSvg: null, claimedAt: createdAt, createdAt });
    expect(on.device).toMatch(/^phone-bbbbbbbb/);
    expect(JSON.stringify(on)).not.toContain("a".repeat(64));
    const rotated = (await fx.post("rotate")).json();
    expect(rotated).toMatchObject({ paired: false, device: null });
    expect(rotated.link).toMatch(/^dave:/);
    expect(fx.store.read()?.key).not.toBe("a".repeat(64));
    const off = (await fx.post("disable")).json();
    expect(off).toMatchObject({ enabled: false, listening: false, link: null });
    expect(fx.store.read()).not.toBeNull();
    const gone = (await fx.post("forget")).json();
    expect(gone).toMatchObject({ enabled: false, listening: false, paired: false, createdAt: null });
    expect(fx.store.read()).toBeNull();
  });

  it("persists enabled and reopens the listener at boot only when enabled", async () => {
    const store = memoryPairingStore();
    const first = await fixture({ store });
    await first.post("enable");
    await first.app.close();
    apps.splice(apps.indexOf(first.app), 1);
    const second = await fixture({ store, home: first.home });
    expect(await second.status()).toMatchObject({ enabled: true, listening: true });
  });

  it("does not listen unless the gateway was started explicitly", async () => {
    const fx = await fixture({ listen: false });
    expect((await fx.post("enable")).json()).toMatchObject({ enabled: true, listening: false, link: null });
  });

  it("reports Keychain failures as errors, not crashes", async () => {
    const broken: PairingStore = { read: () => { throw new Error("Secure storage unavailable"); }, write: () => { throw new Error("Secure storage unavailable"); }, delete: () => undefined };
    const fx = await fixture({ store: broken });
    const res = await fx.post("enable");
    expect(res.statusCode).toBe(200);
    expect(res.json().error).toMatch(/Keychain/);
    expect(res.json().listening).toBe(false);
  });

  it("applies the request guard", async () => {
    const fx = await fixture();
    const cross = await fx.app.inject({ method: "POST", url: "/api/mobile/pairing/enable", headers: { host: "localhost:4317", origin: "http://evil.example" }, payload: {} });
    expect(cross.statusCode).toBe(403);
    const noToken = await fx.app.inject({ method: "POST", url: "/api/mobile/pairing/enable", headers, payload: {} });
    expect(noToken.statusCode).toBe(403);
    expect((await fx.app.inject({ method: "POST", url: "/api/mobile/pairing/enable", headers: { ...headers, "x-dave-csrf": "0".repeat(64) }, payload: { extra: 1 } })).statusCode).toBe(403);
    expect((await fx.status()).enabled).toBe(false);
  });
});

describe("pairing store and host discovery", () => {
  it("treats malformed records as absent and fails closed off macOS", () => {
    let value: string | null = "{not json";
    const entry: SecretEntry = { getPassword: () => value, setPassword: v => { value = v; }, deleteCredential: () => true };
    expect(pairingStore(() => entry, "darwin").read()).toBeNull();
    value = JSON.stringify({ v: 1, key: "zz", createdAt: "2026-10-01T00:00:00.000Z" });
    expect(pairingStore(() => entry, "darwin").read()).toBeNull();
    expect(parsePairingRecord({ v: 1, key: "a".repeat(64), createdAt: "2026-10-01T00:00:00.000Z" })).not.toBeNull();
    let opens = 0;
    expect(() => pairingStore(() => { opens++; return entry; }, "linux").read()).toThrow("Secure storage unavailable");
    expect(opens).toBe(0);
  });

  it("ranks real interfaces first and adds the hostname", () => {
    const v4 = (address: string, internal = false) => ({ address, family: "IPv4" as const, internal, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: null });
    const hosts = lanHosts({
      bridge100: [v4("192.168.64.1")], en0: [v4("192.168.1.20"), { ...v4("fe80::1"), family: "IPv6" as const, scopeid: 0 }],
      lo0: [v4("127.0.0.1", true)], en5: [v4("169.254.3.4")], utun3: [v4("10.8.0.2")], awdl0: [v4("10.0.0.9")],
    }, "Daves-MacBook");
    expect(hosts).toEqual(["192.168.1.20", "10.0.0.9", "192.168.64.1", "10.8.0.2", "Daves-MacBook.local"]);
    expect(lanHosts({}, "bad host!")).toEqual([]);
  });
});
