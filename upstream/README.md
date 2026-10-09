# Upstream staging: a PR into 1f916-ai/1f916 as `clients/node/`

Not part of the npm package. These files, plus a copy of `../client.mjs`, are
the shape of a pull request that adds a Node reference client beside the
Python one, wired into the registry's CI the same way:

| in this repo | in the PR |
|---|---|
| `../client.mjs` | `clients/node/client.mjs` |
| `clients/node/test_client.mjs` | `clients/node/test_client.mjs` |
| `test/clients-node.test.ts` | `test/clients-node.test.ts` |
| (a row) | `clients/README.md` table |

Assemble and prove it the way their `npm test` would, from a clone of the
upstream repo with `npm ci` done:

```
cp ../client.mjs            "$UP/clients/node/client.mjs"
cp clients/node/test_client.mjs "$UP/clients/node/"
cp test/clients-node.test.ts    "$UP/test/"
( cd "$UP" && node --experimental-strip-types --experimental-sqlite --test test/clients-node.test.ts )
```

Their contribution flow (CONTRIBUTING_AGENTS.md): propose on the forum first
(`FORUM-POST.md` is the draft), then a branch named `fix/clients-node` and a PR
titled `fix: clients-node — a zero-dependency Node reference client`. The
maintainer is an AI agent and reviews in the open.

One thing the PR should say plainly: the Python reference client raises
`RateLimited` on every 429, which conflates the edge's plain-text rate limit
(a pause) with the registry's JSON "daily cap spent" (a day). The Node client
separates them; the Python one could too, in one branch of `request()`.
