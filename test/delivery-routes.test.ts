import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import { buildServer } from "../src/server/index.ts";
import { sourcePaths } from "../src/shared/paths.ts";
import { openDb } from "../src/db/index.ts";
import { repo } from "../src/db/repo.ts";
import { createProviderService, type OwnedAuth } from "../src/providers/index.ts";
import { OpenAIAuthError } from "../src/providers/openai-auth.ts";
import { tempDir, AT } from "./helpers.ts";
import type { FastifyInstance } from "fastify";
import type { DeliveryState } from "../src/model/delivery-schema.ts";
import type { CoordinationState } from "../src/model/delivery-coordination.ts";
import { deriveDeliveryProgress } from "../src/model/delivery-progress.ts";
import { resultTemplate } from "../src/ui/coordination-handoff.ts";
const apps: FastifyInstance[] = [], homes: string[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });
const goal = { goal: "Daily member onboarding", intendedUser: "Members", workflow: "Complete onboarding", stage: "Prototype", provider: "openai", model: "gpt-6-astra", consent: null };
const plan = { assumptions: [], milestones: ["Guided member onboarding", "Staff review and corrections", "Daily operational recovery"].map((title, i) => ({ title, outcome: `Members finish ${title.toLowerCase()} without losing progress`, whyNow: "Required for daily work", scope: ["Validation, persistence, recovery and usable completion"], exclusions: [], acceptance: ["A member finishes the whole workflow", "Progress survives restart and errors are recoverable"], sourceIds: [], humanPrerequisites: [], dependencies: i ? [i - 1] : [] })) };
async function fixture() {
  const home = tempDir("delivery-routes-"); homes.push(home);
  const paths = sourcePaths(home, home);
  const db = openDb(paths.appHome), id = repo(db).ensureProject(home, "Synthetic", AT); db.close();
  const infer = vi.fn(async () => JSON.stringify(plan));
  const auth = { status: vi.fn(() => ({ provider: "openai", storage: "keychain", state: "disconnected", accountId: "PRIVATE", accessToken: "PRIVATE" })), restore: vi.fn(), connect: vi.fn(async () => { throw new OpenAIAuthError("port_unavailable"); }), cancel: vi.fn(), disconnect: vi.fn(), dispose: vi.fn(), getCredentials: vi.fn() };
  const factory = vi.fn(() => auth as unknown as OwnedAuth);
  const providers = createProviderService({ authFactory: factory, inference: infer });
  async function server() {
    const app = await buildServer(paths, { providers }); apps.push(app);
    const headers = { host: "localhost:4317", origin: "http://localhost:4317" };
    const token = (await app.inject({ url: "/api/security/csrf", headers })).json().token;
    return { app, get: (url: string) => app.inject({ url, headers }), post: (url: string, payload: object) => app.inject({ method: "POST", url, headers: { ...headers, "x-dave-csrf": token }, payload }) };
  }
  return { ...await server(), server, paths, id, base: `/api/projects/${id}/delivery`, infer, auth, factory };
}
it("guards hostile requests, unknown fields/projects/revisions and provider metadata without restoring or polling", async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) { expect((await f.get("/api/providers")).body).not.toContain("PRIVATE"); await f.get(f.base); }
  expect(f.factory).not.toHaveBeenCalled(); expect(f.infer).not.toHaveBeenCalled();
  expect((await f.app.inject({ method: "POST", url: f.base + "/goal", headers: { host: "localhost:4317", origin: "https://evil.test" }, payload: {} })).statusCode).toBe(403);
  expect((await f.app.inject({ method: "POST", url: f.base + "/goal", headers: { host: "localhost:4317", origin: "http://localhost:4317" }, payload: {} })).statusCode).toBe(403);
  expect((await f.post("/api/projects/missing/delivery/goal", { expectedRevision: 0, goal })).statusCode).toBe(404);
  expect((await f.post(f.base + "/goal", { expectedRevision: 0, goal, extra: "PRIVATE" })).statusCode).toBe(400);
  expect((await f.post(f.base + "/goal", { expectedRevision: -1, goal })).statusCode).toBe(400);
  expect((await f.post(f.base + "/goal", { expectedRevision: 0, goal })).statusCode).toBe(200);
  const conflict = await f.post(f.base + "/goal", { expectedRevision: 0, goal }); expect(conflict.statusCode).toBe(409); expect(conflict.json().state.revision).toBe(1);
  const login = await f.post("/api/providers/openai/connect", { storage: "session" }); expect(login.statusCode).toBe(202);
  await Promise.resolve(); const status = (await f.get("/api/providers")).json(); expect(status.operation.error).toBe("port_unavailable"); expect(status.operation.message).toContain("1455"); expect(JSON.stringify(status)).not.toContain("PRIVATE"); expect(f.auth.connect).toHaveBeenCalledTimes(1);
  expect(status.claude.state).toBe("unavailable"); expect(f.auth.restore).not.toHaveBeenCalled();
  expect((await f.post("/api/providers/openai/cancel", { operationId: "wrong" })).statusCode).toBe(404);
});
it("requires exact server preview approval, persists operations on reload and completes exactly once without automatic continuation", async () => {
  const f = await fixture(); await f.post(f.base + "/goal", { expectedRevision: 0, goal });
  expect((await f.post(f.base + "/generate", { expectedRevision: 1, packet: {} })).statusCode).toBe(400);
  expect((await f.post(f.base + "/generate", { expectedRevision: 1 })).statusCode).toBe(409);
  const selection = { collect: true, categories: ["goal", "history"], documents: [] };
  const preview = (await f.post(f.base + "/context/preview", { expectedRevision: 1, permissions: selection })).json();
  expect((await f.post(f.base + "/context/approve", { expectedRevision: 1, fingerprint: "wrong" })).statusCode).toBe(409);
  expect((await f.post(f.base + "/context/approve", { expectedRevision: 1, fingerprint: preview.packet.fingerprint })).statusCode).toBe(200);
  const generated = await f.post(f.base + "/generate", { expectedRevision: 2 }); expect(generated.statusCode).toBe(202);
  await new Promise(resolve => setImmediate(resolve));
  let saved = (await f.get(f.base)).json(); expect(saved.operation.status).toBe("success"); expect(f.infer).toHaveBeenCalledTimes(1);
  await f.app.close(); apps.splice(apps.indexOf(f.app), 1);
  const reloaded = await f.server(); saved = (await reloaded.get(f.base)).json(); expect(saved.operation.id).toBe(generated.json().operation.id);
  expect((await reloaded.post(f.base + "/wrong/complete", { expectedRevision: saved.state.revision, idempotencyKey: "wrong", report: { outcome: "Delivered", evidence: "Synthetic report" } })).statusCode).toBe(409);
  for (let i = 0; i < 3; i++) {
    const url = f.base + `/${saved.state.currentMilestoneId}/complete`, body = { expectedRevision: saved.state.revision, idempotencyKey: `completion-${i}`, report: { outcome: "Delivered capability", evidence: "User ran synthetic workflow" } };
    const completed = await reloaded.post(url, body); expect(completed.statusCode).toBe(200); expect(completed.json().source).toBe("user-reported");
    const duplicate = await reloaded.post(url, body); expect(duplicate.json().duplicate).toBe(true); expect(duplicate.json().state.revision).toBe(completed.json().state.revision);
    saved = completed.json();
  }
  expect(saved.recovery).toBe("Saved queue exhausted. Define a finish line and review evidence; no model request was made."); expect(saved.state.history.filter((e: { kind: string }) => e.kind === "complete")).toHaveLength(3);
  expect(f.infer).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 3; i++) await reloaded.get(f.base);
  expect(f.infer).toHaveBeenCalledTimes(1);
});
it("runs the entire guarded local coordination loop without calling a provider or allowing legacy bypass", async () => {
  const f = await fixture();
  const localGoal = { ...goal, provider: null, model: null };
  await f.post(f.base + "/goal", { expectedRevision: 0, goal: localGoal });
  const contract = { outcome: "Bounded fixture pilot", exclusions: [], criteria: [{ text: "Full workflow completes", milestones: [2] }, { text: "Recovery is demonstrated", milestones: [2] }], prerequisites: [] };
  expect((await f.post(f.base + "/coordination/contract", { expectedRevision: 1, contract, unexpected: true })).statusCode).toBe(400);
  expect((await f.post(f.base + "/coordination/contract", { expectedRevision: 1, contract })).statusCode).toBe(200);
  let response = await f.post(f.base + "/coordination/plan", { expectedRevision: 2, plan: JSON.stringify(plan) });
  expect(response.statusCode).toBe(200);
  let saved: { state: DeliveryState; coordination: CoordinationState } = response.json();
  expect((await f.post(f.base + `/wrong/complete`, { expectedRevision: saved.state.revision, idempotencyKey: "legacy", report: { outcome: "claimed", evidence: "unstructured" } })).statusCode).toBe(400);
  expect((await f.post(f.base + "/coordination/handoff", { expectedRevision: saved.state.revision, milestoneId: "wrong" })).statusCode).toBe(400);
  for (let i = 0; i < 3; i++) {
    const item = deriveDeliveryProgress(saved.state, saved.coordination).next!;
    response = await f.post(f.base + "/coordination/handoff", { expectedRevision: saved.state.revision, milestoneId: item.milestone.id });
    expect(response.statusCode).toBe(200); saved = response.json();
    const handoff = saved.coordination.handoffs.find(h => h.milestoneId === item.milestone.id)!;
    const report = resultTemplate(f.id, handoff); report.outcome = "Synthetic workflow observed";
    report.criteria.forEach(c => { c.status = "met"; c.evidence = "Observed fixture success, not live acceptance"; });
    response = await f.post(f.base + "/coordination/report", { expectedRevision: saved.state.revision, idempotencyKey: `result-${i}`, report });
    expect(response.statusCode).toBe(200); saved = response.json();
    expect(deriveDeliveryProgress(saved.state, saved.coordination).next?.status).toBe("needs-review");
    response = await f.post(f.base + "/coordination/review", { expectedRevision: saved.state.revision, milestoneId: item.milestone.id, action: "accept", reason: "Reviewed synthetic evidence; human acceptance only" });
    expect(response.statusCode).toBe(200); saved = response.json();
  }
  expect(deriveDeliveryProgress(saved.state, saved.coordination).readyForReview).toBe(true);
  expect(saved.state.nextPlans).toEqual([]);
  expect((await f.post(f.base + "/coordination/focus", { expectedRevision: saved.state.revision })).statusCode).toBe(200);
  expect((await f.get("/api/delivery/focus")).json()).toEqual({ projectId: f.id });
  expect((await f.post(`/api/projects/${f.id}/override`, { hidden: true })).statusCode).toBe(200);
  expect((await f.get("/api/delivery/focus")).json()).toEqual({ projectId: f.id }); // Never silently retarget a hidden focus.
  expect((await f.post(`/api/projects/${f.id}/override`, { hidden: false })).statusCode).toBe(200);
  await f.app.close(); apps.splice(apps.indexOf(f.app), 1); const restarted = await f.server();
  const restored = (await restarted.get(f.base)).json(); expect(restored.coordination.reports).toHaveLength(3);
  expect(f.infer).not.toHaveBeenCalled(); expect(f.factory).not.toHaveBeenCalled();
});
it("mode switching disposes rather than disconnecting persisted credentials", () => {
  const auth = { restore: vi.fn(), dispose: vi.fn(), disconnect: vi.fn() } as unknown as OwnedAuth;
  const service = createProviderService({ authFactory: () => auth });
  service.restore("keychain"); service.restore("session"); expect(auth.dispose).toHaveBeenCalledTimes(1); expect(auth.disconnect).not.toHaveBeenCalled(); service.close();
});
it("block/reopen preserve reports and exhaustion never calls the provider or replays completion", async () => {
  const f = await fixture();
  await f.post(f.base + "/goal", { expectedRevision: 0, goal });
  const preview = (await f.post(f.base + "/context/preview", { expectedRevision: 1, permissions: { collect: true, categories: ["goal"], documents: [] } })).json();
  await f.post(f.base + "/context/approve", { expectedRevision: 1, fingerprint: preview.packet.fingerprint });
  await f.post(f.base + "/generate", { expectedRevision: 2 });
  await new Promise(resolve => setImmediate(resolve));
  let state = (await f.get(f.base)).json().state;
  const first = state.currentMilestoneId;
  let response = await f.post(`${f.base}/${first}/block`, { expectedRevision: state.revision, reason: "Owner access required" });
  expect(response.statusCode).toBe(200); state = response.json().state;
  expect(state.plans[0].milestones[0].status).toBe("blocked");
  response = await f.post(`${f.base}/${first}/reopen`, { expectedRevision: state.revision, reason: "Owner supplied fixture access" });
  expect(response.statusCode).toBe(200); state = response.json().state;
  f.infer.mockRejectedValue(new Error("PRIVATE provider error"));
  let lastUrl = "", lastBody = {};
  for (let i = 0; i < 3; i++) {
    lastUrl = `${f.base}/${state.currentMilestoneId}/complete`;
    lastBody = { expectedRevision: state.revision, idempotencyKey: `failed-next-${i}`, report: { outcome: "Delivered", evidence: "User-reported synthetic check" } };
    response = await f.post(lastUrl, lastBody); expect(response.statusCode).toBe(200); state = response.json().state;
  }
  await new Promise(resolve => setImmediate(resolve));
  const saved = (await f.get(f.base)).json(); expect(saved.operation.status).toBe("success"); expect(JSON.stringify(saved)).not.toContain("PRIVATE");
  expect(saved.state.history.filter((e: { kind: string }) => e.kind === "complete")).toHaveLength(3);
  expect((await f.post(lastUrl, lastBody)).json().duplicate).toBe(true); expect(f.infer).toHaveBeenCalledTimes(1);
  expect((await f.post(f.base + "/cancel", { expectedRevision: state.revision, operationId: "wrong" })).statusCode).toBe(404);
});
