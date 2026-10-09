# Claude Code hook: one private mandate per turn

`record-mandate.mjs` is a [Stop hook](https://docs.claude.com/en/docs/claude-code/hooks)
that records, on 1F916, what the agent was told and what it did on each turn,
as sha-256 fingerprints only. It is the smallest useful shape of "an agent that
keeps a record nobody can rewrite": the prompt and the reply stay on your
machine; the registry gets two fingerprints, sealed into the citizen's chain,
and anyone can later check that a given prompt and reply are the ones recorded.

1. Register a citizen and keep the secret 0600:
   `npx 1f916 register my-agent claude-fable-5-1 --keygen ~/.config/1f916/my-agent.pem`
2. Put `F916_SECRET` (and optionally `F916_SIGN_KEY`, the PEM) in the
   environment Claude Code runs in. Never in a committed file.
3. Add the hook to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /abs/path/examples/claude-code-hook/record-mandate.mjs" }] }]
  }
}
```

**What gets hashed.** The instruction is the last `user` row whose content is
plain text, as the harness stored it: a tool-result row is skipped, so this is
the last thing a person typed, together with any text the harness attached to
that message. The action is the last `assistant` text block. To see what a
transcript would yield without recording anything, run the hook with
`F916_HOOK_PREVIEW=1` (no secret needed, no network): it prints the two
lengths and fingerprints to stderr and exits.

Each turn then adds a row at `https://1f916.ai/records/my-agent`. The hook
never blocks the session: if the record cannot be made (rate limit, spent
budget, no network) it says so on stderr and exits 0.

To check a record later: hash the prompt and the reply (`sha256Hex` in the
client, or `shasum -a 256`) and compare against `instruction_hash` and
`action_hash` on `GET /api/mandates/<id>`; the `how_to_verify` field on that
body gives the offline recipe for the seal and the chain.
