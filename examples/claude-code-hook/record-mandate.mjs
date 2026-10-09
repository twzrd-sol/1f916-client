#!/usr/bin/env node
// A Claude Code Stop hook that records one private mandate per turn on 1F916:
// what the agent was told (the user's last prompt) and what it did (its last
// reply), as sha-256 fingerprints only. The text never leaves the machine.
//
// Install (in ~/.claude/settings.json or a project's .claude/settings.json):
//
//   {
//     "hooks": {
//       "Stop": [{ "hooks": [{ "type": "command",
//                  "command": "node /path/to/record-mandate.mjs" }] }]
//     }
//   }
//
// Needs F916_SECRET (the citizen's secret, from your 0600 file) in the
// environment Claude Code runs in. F916_HOOK_PREVIEW=1 prints what would be
// fingerprinted and sends nothing. Optional: F916_SIGN_KEY (PKCS#8 PEM of a
// key bound with `1f916 bind-key`) signs each record; F916_SUBJECT labels who
// the record was made for; F916_REGISTRY overrides the origin.
//
// The hook reads the transcript path from the Stop event on stdin, takes the
// last user prompt and the last assistant text, and records
// {instruction_hash, action_hash}. Exit 0 always: a record that could not be
// made must never block the session, and the reason is printed to stderr.
import { readFileSync } from "node:fs";
import { Citizen, loadPrivateKey, sha256Hex, ApiError, RateLimited } from "../../client.mjs";

const stdin = readFileSync(0, "utf8");
let event = {};
try { event = JSON.parse(stdin); } catch { /* no event: nothing to record */ }
if (event.stop_hook_active) process.exit(0);          // a Stop hook re-entering itself
const secret = process.env.F916_SECRET;
if (!event.transcript_path) process.exit(0);

let lastUser = null, lastAssistant = null;
try {
  for (const line of readFileSync(event.transcript_path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    const msg = row.message || row;
    const role = msg.role || row.type;
    const text = Array.isArray(msg.content)
      ? msg.content.filter((c) => c && c.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n")
      : typeof msg.content === "string" ? msg.content : null;
    if (!text) continue;
    if (role === "user") lastUser = text;
    else if (role === "assistant") lastAssistant = text;
  }
} catch (e) {
  process.stderr.write(`1f916 hook: cannot read transcript: ${e.message}\n`);
  process.exit(0);
}
if (!lastUser || !lastAssistant) process.exit(0);
if (process.env.F916_HOOK_PREVIEW) {
  // A local look at what would be fingerprinted. Nothing is sent.
  process.stderr.write(`1f916 hook preview: instruction ${[...lastUser].length} chars ${sha256Hex(lastUser)}\n1f916 hook preview: action ${[...lastAssistant].length} chars ${sha256Hex(lastAssistant)}\n`);
  process.exit(0);
}
if (!secret) process.exit(0);

try {
  const me = new Citizen(secret, { origin: process.env.F916_REGISTRY || undefined });
  const sign = process.env.F916_SIGN_KEY ? { privateKey: loadPrivateKey(readFileSync(process.env.F916_SIGN_KEY)) } : null;
  if (sign) await me.verify();                       // signing needs the handle
  const r = await me.mandate({ instruction: lastUser, action: lastAssistant, subject: process.env.F916_SUBJECT || null, sign });
  process.stderr.write(`1f916 hook: recorded mandate ${r.id} (${me.origin}${r.page || `/mandates/${r.id}`})\n`);
} catch (e) {
  const why = e instanceof RateLimited ? e.message : e instanceof ApiError ? `${e.message}${e.authClass ? ` (auth: ${e.authClass})` : ""}` : (e && e.message) || String(e);
  process.stderr.write(`1f916 hook: not recorded: ${why}\n`);
}
process.exit(0);
