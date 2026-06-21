#!/usr/bin/env node
// Cross-platform replacement for the old `find ... -exec node --check` script,
// which broke under npm-on-Windows (cmd's find.exe). Dependency-free: only node
// builtins. Recursively walks the repo from cwd, skips node_modules/.git/dotdirs,
// runs `node --check` on every *.js file, and reports failures.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

function collectJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    // Skip node_modules, .git, and any dot-directory.
    if (entry === "node_modules" || entry === ".git" || entry.startsWith(".")) {
      continue;
    }
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // unreadable/disappeared — skip
    }
    if (st.isDirectory()) {
      collectJsFiles(full, out);
    } else if (st.isFile() && entry.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

const root = process.cwd();
const files = collectJsFiles(root);
const failures = [];

for (const file of files) {
  try {
    execFileSync("node", ["--check", file], { stdio: "pipe" });
  } catch (err) {
    const stderr = err?.stderr ? err.stderr.toString() : String(err?.message ?? err);
    failures.push({ file, stderr });
  }
}

if (failures.length > 0) {
  for (const { file, stderr } of failures) {
    console.error(`FAIL: ${file}`);
    console.error(stderr.trim());
    console.error("");
  }
  console.error(`Syntax check FAILED: ${failures.length} of ${files.length} file(s) had errors.`);
  process.exit(1);
}

console.log(`Syntax check passed: ${files.length} file(s) checked.`);
process.exit(0);
