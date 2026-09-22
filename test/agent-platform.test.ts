import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { openDb, type Db } from "../src/db/index.ts";
import { repo } from "../src/db/repo.ts";
import { agentStore } from "../src/agents/store.ts";
import { agentService } from "../src/agents/service.ts";
import { registerAgentRoutes } from "../src/server/agent-routes.ts";
import { registerRequestGuard } from "../src/server/request-guard.ts";
import type { AgentRun, RunStatus } from "../src/agents/types.ts";
import { capture } from "../src/agents/workspace.ts";
import { commandOutput, startProcess, killGroup } from "../src/agents/process.ts";
import { once } from "node:events";
import { deliveryRepo } from "../src/db/delivery-repo.ts";
import { deliveryCoordinationRepo } from "../src/db/delivery-coordination-repo.ts";
import { deriveDeliveryProgress } from "../src/model/delivery-progress.ts";

// Real subprocess and Git integration, with each state wait independently bounded.
vi.setConfig({ testTimeout: 20000 });
const fixture = fileURLToPath(new URL("./fixtures/agent-acp.mjs", import.meta.url));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
function repository(dir: string) {
  fs.mkdirSync(dir);
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", dir, ...args], { stdio: "pipe" });
  git("init", "-q"); fs.writeFileSync(path.join(dir, "README.md"), "Fixture project\n");
  git("add", "README.md"); git("-c", "user.name=DAVE fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", "fixture");
  return fs.realpathSync(dir);
}
function setup() {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dave-agents-"))), home = path.join(temp, "home");
  const projectPath = repository(path.join(temp, "project")), otherPath = repository(path.join(temp, "other"));
  const db = openDb(home), p = repo(db), now = new Date().toISOString();
  const projectId = p.ensureProject(projectPath, "Fixture project", now), otherId = p.ensureProject(otherPath, "Other project", now);
  const store = agentStore(db), service = agentService(store, home, { command: process.execPath, args: [fixture] });
  cleanups.push(async () => { await service.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  store.configure({ enabled: true, paused: false, acknowledgeRisk: true, maxConcurrent: 2, maxPerProject: 1, reviewLimit: 3, timeoutMinutes: 1 });
  const enqueue = (extra: Record<string, unknown> = {}) => store.enqueue({ requestKey: randomUUID(), projectId, title: "Implement change", prompt: "CHANGE", criteria: ["The file contains the intended change"], checks: [], authorizeExecution: true, ...extra });
  const wait = async (id: string, status: RunStatus) => { await vi.waitFor(() => expect(store.read(id).status, JSON.stringify(store.read(id))).toBe(status), { timeout: 12000, interval: 25 }); return store.read(id); };
  const action = (r: AgentRun, value: object) => service.action(r.id, { revision: r.revision, ...value });
  return { temp, home, db, store, service, projectId, otherId, projectPath, enqueue, wait, action };
}

describe("connected agent platform", () => {
  it("runs a real ACP child in a worktree, checks it, returns feedback into the same session, and accepts exact evidence", async () => {
    const s = setup();
    const checks = [{ label: "Read result", command: process.execPath, args: ["-e", "if(require('fs').readFileSync('work.txt','utf8').length<1)process.exit(1);console.log('verified')"] }];
    const first = s.enqueue({ checks }); s.service.tick();
    let r = await s.wait(first.id, "review");
    expect(r.packet?.files).toContain("work.txt"); expect(r.packet?.diff).toContain("implemented");
    const firstPacket = s.store.history(r.id)[0]!;
    expect(fs.existsSync(path.join(s.projectPath, "work.txt"))).toBe(false);
    await expect(s.action(r, { action: "accept", reason: "Reviewed", confirmCriteria: true, fingerprint: r.packet?.fingerprint })).rejects.toThrow("run all checks");
    await s.action(r, { action: "reply", message: "CHANGE FOLLOWUP" });
    r = await s.wait(first.id, "review");
    expect(r.turn).toBe(2); expect(r.sessionId).toBe("fixture-session");
    expect(s.store.evidence(r.id, firstPacket.id).diff).toContain("implemented");
    expect(r.packet?.diff).toContain("revised");
    expect(s.store.events(r.id).some(e => e.text.includes("Existing session loaded"))).toBe(true);
    await s.action(r, { action: "check" }); r = await s.wait(r.id, "review");
    expect(r.packet?.checks[0]).toMatchObject({ exitCode: 0, output: "verified\n" });
    const accepted = await s.action(r, { action: "accept", reason: "Inspected the revised output", confirmCriteria: true, fingerprint: r.packet?.fingerprint });
    expect(accepted.status).toBe("accepted");
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM agent_reviews").get()).toMatchObject({ n: 2 });
  });

  it("rolls back packet and run changes together when evidence storage fails", async () => {
    const s = setup(), a = s.enqueue(); s.service.tick(); const r = await s.wait(a.id, "review");
    s.db.exec("CREATE TRIGGER fail_packet BEFORE INSERT ON agent_packets BEGIN SELECT RAISE(ABORT,'fixture packet failure'); END");
    expect(() => s.store.patch(a.id, { packet: r.packet, reason: "must roll back" })).toThrow("fixture packet failure");
    expect(s.store.read(a.id)).toEqual(r); expect(s.store.history(a.id)).toHaveLength(1);
    const b = s.enqueue(); expect(() => s.store.evidence(b.id, s.store.history(a.id)[0]!.id)).toThrow("not found");
  });

  it("surfaces one-time permissions, rejects fabricated grants, and resumes the waiting process", async () => {
    const s = setup(), queued = s.enqueue({ prompt: "CHANGE WAIT_PERMISSION" }); s.service.tick();
    let r = await s.wait(queued.id, "waiting");
    expect(r.permission?.options.map(o => o.optionId)).toEqual(["once", "no"]);
    await expect(s.action(r, { action: "permission", optionId: "always" })).rejects.toThrow("Permission request changed");
    await s.action(r, { action: "permission", optionId: "once" });
    r = await s.wait(r.id, "review"); expect(r.permission).toBeNull(); expect(r.packet?.files).toContain("work.txt");
  });

  it("enforces global/project limits and does not dispatch dependencies until human acceptance", async () => {
    const s = setup(), first = s.enqueue({ prompt: "HANG" }), same = s.enqueue({ prompt: "HANG" }), other = s.enqueue({ projectId: s.otherId, prompt: "HANG" });
    s.service.tick(); await s.wait(first.id, "running"); await s.wait(other.id, "running"); expect(s.store.read(same.id).status).toBe("queued");
    await s.action(s.store.read(first.id), { action: "stop" }); await s.wait(same.id, "running");
    await s.action(s.store.read(same.id), { action: "stop" }); await s.action(s.store.read(other.id), { action: "stop" });
    const a = s.enqueue(), b = s.enqueue({ dependencies: [a.id] }); s.service.tick();
    const r = await s.wait(a.id, "review"); expect(s.store.read(b.id).status).toBe("queued");
    await s.action(r, { action: "accept", confirmCriteria: true, acknowledgeNoChecks: true, reason: "Manually verified", fingerprint: r.packet?.fingerprint });
    await s.wait(b.id, "review");
  });

  it("pauses dispatch when review backlog reaches its bound", async () => {
    const s = setup(); s.store.configure({ ...s.store.settings(), reviewLimit: 1 });
    const a = s.enqueue(), b = s.enqueue(); s.service.tick(); await s.wait(a.id, "review");
    expect(s.store.read(b.id).status).toBe("queued");
  });

  it("rejects stale evidence and failed checks; refreshing cannot inherit prior check success", async () => {
    const s = setup(), a = s.enqueue({ checks: [{ label: "Fails", command: process.execPath, args: ["-e", "process.exit(1)"] }] }); s.service.tick();
    let r = await s.wait(a.id, "review"); await s.action(r, { action: "check" }); r = await s.wait(a.id, "review");
    expect(r.packet?.checks[0]?.exitCode).toBe(1);
    await expect(s.action(r, { action: "accept", reason: "Looks fine", confirmCriteria: true, fingerprint: r.packet?.fingerprint })).rejects.toThrow("checks successfully");
    const b = s.enqueue(); s.service.tick(); r = await s.wait(b.id, "review");
    fs.writeFileSync(path.join(r.workspace!, "work.txt"), "changed after evidence\n");
    await expect(s.action(r, { action: "accept", reason: "Reviewed", confirmCriteria: true, acknowledgeNoChecks: true, fingerprint: r.packet?.fingerprint })).rejects.toThrow("stale");
    await s.action(r, { action: "refresh" }); expect(s.store.read(r.id).packet?.checks).toEqual([]);
  });

  it("requires fresh evidence after a check mutates source", async () => {
    const s = setup(), a = s.enqueue({ checks: [{ label: "Mutating", command: process.execPath, args: ["-e", "require('fs').writeFileSync('work.txt','mutated')"] }] }); s.service.tick();
    let r = await s.wait(a.id, "review"); await s.action(r, { action: "check" }); r = await s.wait(a.id, "review");
    expect(r.packet).toBeNull(); expect(r.reason).toContain("changed the workspace");
  });

  it("stops owned descendant processes and retains the worktree", async () => {
    const s = setup(), a = s.enqueue({ prompt: "SPAWN_CHILD HANG" }); s.service.tick();
    const r = await s.wait(a.id, "running");
    await vi.waitFor(() => expect(fs.existsSync(path.join(r.workspace!, "child.pid"))).toBe(true));
    const pid = Number(fs.readFileSync(path.join(r.workspace!, "child.pid"), "utf8"));
    await s.action(s.store.read(a.id), { action: "stop" });
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 3000 });
    expect(fs.existsSync(r.workspace!)).toBe(true); expect(s.store.read(a.id).status).toBe("stopped");
  });

  it("persists recovery state without automatically resuming paid work", async () => {
    const s = setup(), a = s.enqueue({ prompt: "HANG" }); s.service.tick(); await s.wait(a.id, "running");
    await s.service.close(); expect(s.store.read(a.id).status).toBe("interrupted");
    const resumed = agentService(s.store, s.home, { command: process.execPath, args: [fixture] });
    try {
      expect(s.store.settings().paused).toBe(true); const r = s.store.read(a.id);
      await expect(resumed.action(r.id, { revision: r.revision, action: "retry", message: "CHANGE" })).rejects.toThrow("Confirm previous agents");
      await resumed.action(r.id, { revision: r.revision, action: "retry", message: "CHANGE", confirmStopped: true });
      expect(s.store.read(r.id).status).toBe("queued");
      s.store.configure({ ...s.store.settings(), paused: false }); resumed.tick(); await s.wait(r.id, "review");
    } finally { await resumed.close(); }
  });

  it("is idempotent, revision checked, and permits only one runtime per app home", async () => {
    const s = setup(), key = randomUUID(), a = s.enqueue({ requestKey: key });
    expect(s.enqueue({ requestKey: key }).id).toBe(a.id);
    expect(() => s.enqueue({ requestKey: key, title: "Different" })).toThrow("already used");
    expect(() => agentService(s.store, s.home)).toThrow("Another DAVE runtime");
    await expect(s.service.action(a.id, { revision: -1, action: "stop" })).rejects.toThrow("Run changed");
    expect(() => s.enqueue({ authorizeExecution: false })).toThrow("Authorize");
  });

  it("bounds malformed agent output and fails visibly without accepting", async () => {
    const s = setup(), a = s.enqueue({ prompt: "FLOOD" }); s.service.tick(); await s.wait(a.id, "failed");
    expect(s.store.read(a.id).packet).toBeNull();
  });

  it("stops a chatty agent when retained output fills rather than losing later evidence silently", async () => {
    const s = setup(), a = s.enqueue({ prompt: "CHATTER" }); s.service.tick(); await s.wait(a.id, "failed");
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM agent_events WHERE run_id=? AND kind='output-limit'").get(a.id)).toMatchObject({ n: 1 });
    expect(s.store.read(a.id).packet).toBeNull();
  });

  it("refuses dirty original checkouts and linked workspace replacements", async () => {
    const s = setup(); fs.writeFileSync(path.join(s.projectPath, "local.txt"), "Keep me");
    const a = s.enqueue(); s.service.tick(); const failed = await s.wait(a.id, "failed");
    expect(failed.reason).toContain("uncommitted"); expect(fs.readFileSync(path.join(s.projectPath, "local.txt"), "utf8")).toBe("Keep me");
    const b = s.enqueue({ projectId: s.otherId }); s.service.tick(); const r = await s.wait(b.id, "review");
    fs.renameSync(r.workspace!, r.workspace! + "-saved"); fs.symlinkSync(s.projectPath, r.workspace!);
    await expect(capture(s.home, r)).rejects.toThrow("path changed");
  });

  it("does not follow untracked file symlinks or expose credential-shaped files in packets", async () => {
    const s = setup(), a = s.enqueue(); s.service.tick(); const r = await s.wait(a.id, "review");
    const secret = path.join(s.temp, "private.txt"); fs.writeFileSync(secret, "do-not-read-me"); fs.symlinkSync(secret, path.join(r.workspace!, "link.txt"));
    const packet = await capture(s.home, r); expect(packet.diff).not.toContain("do-not-read-me");
    fs.writeFileSync(path.join(r.workspace!, ".env"), "PRIVATE=value"); await expect(capture(s.home, r)).rejects.toThrow("Credential-shaped");
  });
});

it("terminates command groups on timeout and guardian pipe loss", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dave-guardian-"));
  cleanups.push(async () => { fs.rmSync(temp, { recursive: true, force: true }); });
  const result = await commandOutput(process.execPath, ["-e", "setInterval(()=>{},1000)"], temp, undefined, 150);
  expect(result.exitCode).toBeNull();
  const child = startProcess(process.execPath, ["-e", "console.log(process.pid);setInterval(()=>{},1000)"], temp);
  cleanups.push(async () => { killGroup(child); });
  const [chunk] = await once(child.stdout, "data"), pid = Number(String(chunk).trim());
  expect(pid).toBeGreaterThan(0);
  const ended = once(child, "close"); child.stdin.destroy(); await ended;
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 3000 });
});

it("returns structured delivery evidence automatically and preserves an exact enqueue retry after completion", async () => {
  const s = setup(); await s.service.close();
  const delivery = deliveryCoordinationRepo(s.db), legacy = deliveryRepo(s.db);
  legacy.saveGoal(s.projectId, 0, { goal: "Fixture delivery", intendedUser: "Fixture operator", workflow: "CHANGE", stage: "Synthetic", provider: null, model: null, consent: null });
  delivery.saveContract(s.projectId, 1, { outcome: "A verified fixture", exclusions: ["No live work"], criteria: [{ text: "File is implemented", milestones: [0] }, { text: "Existing behavior is retained", milestones: [0] }], prerequisites: [] });
  const state = delivery.saveManualPlan(s.projectId, 2, JSON.stringify({ assumptions: ["Fixture only"], milestones: [0,1,2].map(i => ({ title: `CHANGE ${i}`, outcome: `Capability ${i} delivered`, whyNow: "Exercise the integration", scope: ["Fixture file"], exclusions: [], acceptance: ["File exists", "Existing behavior retained"], sourceIds: [], humanPrerequisites: [], dependencies: i ? [i-1] : [] })) }));
  const issued = delivery.handoff(s.projectId, state.state.revision, state.state.plans[0]!.milestones[0]!.id);
  const handoff = issued.coordination.handoffs[0]!;
  const app = Fastify(); const routes = registerAgentRoutes(app, s.db, s.home, { command: process.execPath, args: [fixture] });
  cleanups.push(async () => { await app.close(); });
  routes.store.configure({ ...routes.store.settings(), paused: false });
  const payload = { projectId: s.projectId, handoffId: handoff.id, requestKey: randomUUID(), checks: [], authorizeExecution: true };
  const response = await app.inject({ method: "POST", url: "/api/agents/runs", payload });
  expect(response.statusCode).toBe(200); const id = response.json<AgentRun>().id;
  await s.wait(id, "review");
  const result = delivery.read(s.projectId);
  expect(result.coordination.reports).toHaveLength(1);
  expect(deriveDeliveryProgress(result.state, result.coordination).next?.status).toBe("needs-review");
  expect(result.coordination.decisions).toHaveLength(0);
  const retry = await app.inject({ method: "POST", url: "/api/agents/runs", payload });
  expect(retry.statusCode).toBe(200); expect(retry.json<AgentRun>().id).toBe(id);
});

it("guards every execution endpoint against browser cross-origin writes and malformed cursors", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dave-agent-api-")), db: Db = openDb(temp), app = Fastify();
  registerRequestGuard(app, ["http://127.0.0.1:4310"]); registerAgentRoutes(app, db, temp, { command: process.execPath, args: [fixture] });
  cleanups.push(async () => { await app.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  const headers = { host: "127.0.0.1:4310", origin: "http://127.0.0.1:4310" };
  expect((await app.inject({ method: "POST", url: "/api/agents/settings", headers, payload: {} })).statusCode).toBe(403);
  expect((await app.inject({ url: "/api/agents", headers: { host: "evil.example" } })).statusCode).toBe(403);
  const security = await app.inject({ url: "/api/security/csrf", headers });
  const auth = { ...headers, "x-dave-csrf": security.json().token };
  const result = await app.inject({ method: "POST", url: "/api/agents/settings", headers: auth, payload: { enabled: true, paused: false, maxConcurrent: 2, maxPerProject: 1, reviewLimit: 3, timeoutMinutes: 1 } });
  expect(result.statusCode).toBe(400); expect(result.json().error).toContain("Acknowledge");
  expect((await app.inject({ url: "/api/agents/runs/nope?after=-1", headers })).statusCode).toBe(400);
});
