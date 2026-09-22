import type { AgentStore } from "./store.ts";
import { AcpClient } from "./acp.ts";
import { ACTIVE, AgentError, clean, text, type AgentRun } from "./types.ts";
import { prepareWorkspace, capture, validateWorkspace } from "./workspace.ts";
import { commandOutput, safeOutput } from "./process.ts";
import { runtimeLock } from "./runtime-lock.ts";

type Job = { abort: AbortController; client?: AcpClient; done: Promise<void> };
export type AgentOptions = { command?: string; args?: string[]; onResult?: (run: AgentRun, output: string) => void; beforeDispatch?: (run: AgentRun) => void };
export function agentService(store: AgentStore, appHome: string, options: AgentOptions = {}) {
  const jobs = new Map<string, Job>(), locks = new Set<string>();
  let closed = false;
  const release = runtimeLock(appHome);
  try { store.recover(); } catch(e) { release(); throw e; }
  const command = options.command ?? process.env.DAVE_AGENT_COMMAND ?? "ezcoder";
  const args = options.args ?? ["acp"];
  const fail = (id: string, e: unknown) => {
    if (!ACTIVE.includes(store.read(id).status)) return;
    store.patch(id, { status: "failed", permission: null, reason: e instanceof AgentError ? e.message : "Run failed. Inspect activity and the retained workspace before retrying." });
  };
  async function execute(id: string, job: Job) {
    try {
      let run = store.read(id);
      options.beforeDispatch?.(run);
      const cwd = await prepareWorkspace(appHome, run, (workspace, base) => { store.patch(id, { workspace, base }); }, job.abort.signal);
      job.abort.signal.throwIfAborted();
      run = store.read(id);
      let output = "";
      const client = await AcpClient.start(command, args, cwd, chunk => {
        if (closed || job.abort.signal.aborted) return;
        if (output.length < 256000) output += chunk.slice(0, 256000 - output.length);
        if (!store.event(id, "output", chunk)) job.client?.dispose();
      }, permission => {
        if (!closed && !job.abort.signal.aborted) store.patch(id, { status: permission ? "waiting" : "running", permission });
      });
      job.client = client;
      job.abort.signal.addEventListener("abort", () => client.dispose(), { once: true });
      if (job.abort.signal.aborted) { client.dispose(); return; }
      const sessionId = await client.connect(cwd, run.sessionId);
      job.abort.signal.throwIfAborted();
      store.patch(id, { sessionId, status: "running", turn: run.turn + 1, reason: "", packet: null });
      const prompt = `You are working on a DAVE assignment in ${cwd}. Work only in this workspace. Do not commit, push, deploy, merge, install dependencies, or start nested agents without explicit user authorization. If blocked, finish your turn explaining what decision you need. Claims of completion are not acceptance.\n\nAcceptance criteria:\n${run.criteria.map(c => `- ${c}`).join("\n")}\n\nAssignment / latest feedback:\n${run.nextPrompt}`;
      const result = await client.prompt(prompt, store.settings().timeoutMinutes * 60000);
      client.dispose();
      job.abort.signal.throwIfAborted();
      if (result.stopReason !== "end_turn") throw new AgentError(409, `Agent stopped before completion (${clean(String(result.stopReason), 80)}). Review activity before retrying.`);
      const packet = await capture(appHome, store.read(id), job.abort.signal);
      job.abort.signal.throwIfAborted();
      store.patch(id, { status: "review", packet, permission: null, reason: "Turn ended. Review the response, changes and checks; completion is not assumed." });
      options.onResult?.(store.read(id), output);
    } catch(e) { if (!job.abort.signal.aborted) fail(id, e); }
    finally { job.client?.dispose(); }
  }
  function own(id: string, task: (job: Job) => Promise<void>) {
    const job: Job = { abort: new AbortController(), done: Promise.resolve() };
    jobs.set(id, job);
    job.done = task(job).catch(e => fail(id, e)).finally(() => { jobs.delete(id); if (!closed) tick(); });
  }
  function tick() {
    if (closed) return;
    const settings = store.settings();
    if (!settings.enabled || settings.paused) return;
    const all = store.list();
    if (all.filter(r => r.status === "review").length >= settings.reviewLimit) return;
    const projects = new Set(store.projects().map(p => p.id));
    for (const run of all.filter(r => r.status === "queued").sort((a,b) => a.createdAt.localeCompare(b.createdAt))) {
      if (jobs.size >= settings.maxConcurrent) break;
      if (!projects.has(run.projectId) || locks.has(run.id) || jobs.has(run.id)) continue;
      if ([...jobs.keys()].filter(id => store.read(id).projectId === run.projectId).length >= settings.maxPerProject) continue;
      if (run.dependencies.some(id => store.read(id).status !== "accepted")) continue;
      store.patch(run.id, { status: "starting", reason: "" });
      own(run.id, job => execute(run.id, job));
    }
  }
  const timer = setInterval(tick, 1000); timer.unref();
  async function locked<T>(id: string, fn: () => Promise<T>) {
    if (locks.has(id)) throw new AgentError(409, "Another action is in progress");
    locks.add(id); try { return await fn(); } finally { locks.delete(id); }
  }
  return { tick,
    runner: "ACP (EZCoder by default)",
    async action(id: string, body: Record<string, unknown>) {
      return locked(id, async () => {
        const action = text(body.action, 50);
        if (action === "stop") {
          store.guard(id, body.revision, ["queued", ...ACTIVE]);
          const job = jobs.get(id); job?.abort.abort(); job?.client?.dispose();
          // Set terminal state before awaiting to prevent a close handler advancing it.
          store.patch(id, { status: "stopped", permission: null, reason: "Stopped by you. Workspace and evidence retained." });
          await job?.done;
        } else if (action === "permission") {
          store.guard(id, body.revision, ["waiting"]);
          const client = jobs.get(id)?.client;
          if (!client) throw new AgentError(409, "Agent disconnected");
          client.answer(body.optionId === null ? null : text(body.optionId, 200));
          store.event(id, "permission", body.optionId === null ? "Permission cancelled by user" : "User selected a one-time permission response");
        } else if (action === "dismiss") {
          store.guard(id, body.revision, ["review", "failed", "stopped", "interrupted"]);
          store.patch(id, { status: "stopped", permission: null, reason: text(body.reason, 2000) });
        } else if (action === "reply" || action === "retry") {
          const r = store.guard(id, body.revision, ["review", "failed", "stopped", "interrupted"]);
          if (r.status === "interrupted" && body.confirmStopped !== true) throw new AgentError(409, "Confirm previous agents have stopped before retrying");
          if (r.turn >= 12) throw new AgentError(409, "Turn limit reached; create a smaller assignment");
          const prompt = text(body.message);
          store.transaction(() => { store.review(id, "return", prompt); store.patch(id, { status: "queued", nextPrompt: prompt, permission: null, packet: null, reason: "" }); });
        } else if (action === "check") {
          const r = store.guard(id, body.revision, ["review"]);
          if (!store.settings().enabled) throw new AgentError(409, "Execution is disabled");
          if (!r.checks.length) throw new AgentError(409, "No operator-approved checks configured");
          if (jobs.size >= store.settings().maxConcurrent) throw new AgentError(409, "All execution slots are in use");
          store.patch(id, { status: "checking", reason: "Running operator-approved checks" });
          own(id, async job => {
            try {
              const before = await capture(appHome, r, job.abort.signal);
              const cwd = await validateWorkspace(appHome, r), checks = [];
              for (const check of r.checks) {
                job.abort.signal.throwIfAborted();
                store.event(id, "check", `Running ${check.label}`);
                const result = await commandOutput(check.command, check.args, cwd, job.abort.signal, 120000, 256000);
                checks.push({ ...check, exitCode: result.exitCode, output: safeOutput(result.output) });
              }
              const after = await capture(appHome, r, job.abort.signal);
              if (before.fingerprint !== after.fingerprint) throw new AgentError(409, "Checks changed the workspace; inspect it and run checks again");
              store.patch(id, { status: "review", packet: { ...after, checks }, reason: checks.every(c => c.exitCode === 0) ? "Checks passed. Human review still required." : "Checks failed. Return the work with feedback." });
            } catch(e) { if (!job.abort.signal.aborted) { store.patch(id, { status: "review", packet: null, reason: e instanceof AgentError ? e.message : "Check failed; inspect the workspace" }); } }
          });
        } else if (action === "refresh") {
          const r = store.guard(id, body.revision, ["review"]);
          const packet = await capture(appHome, r);
          store.patch(id, { packet, reason: "Evidence refreshed; configured checks must be rerun." });
        } else if (action === "accept") {
          const r = store.guard(id, body.revision, ["review"]);
          const reason = text(body.reason, 2000);
          if (body.confirmCriteria !== true || !r.packet || r.packet.checks.length !== r.checks.length || r.packet.checks.some(c => c.exitCode !== 0)) throw new AgentError(409, "Confirm criteria and run all checks successfully before accepting");
          if (!r.checks.length && body.acknowledgeNoChecks !== true) throw new AgentError(409, "Explicitly acknowledge manual-only verification");
          const latest = await capture(appHome, r);
          if (body.fingerprint !== r.packet.fingerprint || latest.fingerprint !== r.packet.fingerprint) throw new AgentError(409, "Evidence is stale; refresh and rerun checks");
          store.transaction(() => { store.guard(id, body.revision, ["review"]); store.review(id, "accept", reason); store.patch(id, { status: "accepted", reason }); });
        } else throw new AgentError(400, "Unknown action");
        return store.read(id);
      }).finally(tick);
    },
    async close() {
      if (closed) return;
      closed = true; clearInterval(timer);
      const current = [...jobs.entries()];
      for (const [,job] of current) { job.abort.abort(); job.client?.dispose(); }
      await Promise.all(current.map(([,j]) => j.done));
      try { for (const [id] of current) if (ACTIVE.includes(store.read(id).status)) store.patch(id, { status: "interrupted", permission: null, reason: "Server stopped. Workspace retained; retry explicitly." }); }
      finally { release(); }
    },
  };
}
