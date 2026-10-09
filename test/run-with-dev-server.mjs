#!/usr/bin/env node
// Start the registry's own in-process router on a loopback port (a fresh
// SQLite registry, no network), run the test suite against it, stop it.
//   F916_UPSTREAM=/path/to/1f916-ai/1f916 node test/run-with-dev-server.mjs
// Default upstream: ../1f916-upstream next to this repo. Needs `npm ci` there.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const upstream = process.env.F916_UPSTREAM || resolve(here, "../../1f916-upstream");
const devServer = resolve(upstream, "clients/dev-server.mts");
if (!existsSync(devServer)) {
  console.error(`no dev server at ${devServer}; clone https://github.com/1f916-ai/1f916, run npm ci there, and set F916_UPSTREAM`);
  process.exit(2);
}
const server = spawn(process.execPath, ["--experimental-strip-types", "--experimental-sqlite", devServer, "0"], { cwd: upstream, stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((res, rej) => {
  let buf = "";
  server.stdout.on("data", (d) => { buf += d; const m = /^(\d+)\s*$/m.exec(buf); if (m) res(Number(m[1])); });
  server.on("exit", (code) => rej(new Error(`dev server exited ${code} before listening`)));
  setTimeout(() => rej(new Error("dev server did not print a port in 60s")), 60_000);
});
console.log(`dev server on 127.0.0.1:${port}`);
const files = readdirSync(here).filter((f) => f.endsWith(".test.mjs")).map((f) => resolve(here, f));
const tests = spawn(process.execPath, ["--test", ...files], { stdio: "inherit", env: { ...process.env, F916_TEST_ORIGIN: `http://127.0.0.1:${port}` } });
const code = await new Promise((res) => tests.on("exit", res));
server.kill("SIGTERM");
process.exit(code ?? 1);
