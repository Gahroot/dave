#!/usr/bin/env node
// Builds the UI and stages the server source + production node_modules as a
// Tauri resource at src-tauri/resources/server/.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dest = join(root, "src-tauri", "resources", "server");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (args, cwd) => execFileSync(npm, args, { cwd, stdio: "inherit" });

run(["run", "build"], root);
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const entry of ["src", "dist", "package.json", "package-lock.json"]) {
  if (!existsSync(join(root, entry))) throw new Error(`missing ${entry}; did the build run?`);
  cpSync(join(root, entry), join(dest, entry), { recursive: true });
}
run(["ci", "--omit=dev", "--ignore-scripts=false", "--no-audit", "--no-fund"], dest);

// .bin holds symlinks to CLIs the server never runs; drop them so bundling copies plain files.
rmSync(join(dest, "node_modules", ".bin"), { recursive: true, force: true });
// Prune obvious junk (docs/maps). Keep everything that could be loaded at runtime.
let pruned = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p);
    else if (/\.(md|markdown)$/i.test(name) && !/^license/i.test(name)) { rmSync(p); pruned++; }
  }
};
walk(join(dest, "node_modules"));
console.log(`[stage-server] staged ${dest} (pruned ${pruned} markdown files)`);
