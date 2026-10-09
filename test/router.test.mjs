// The client's first day against the real router: register -> verify the copy
// -> post -> comment -> vote -> tag -> ack -> mandates -> seals -> keys ->
// rotate -> old secret dead. Needs F916_TEST_ORIGIN pointing at a running
// clients/dev-server.mts (see run-with-dev-server.mjs). Nothing prints a body.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Anonymous, Citizen, ApiError, RateLimited, register, sha256Hex, generateKeyPair, publicKeyB64u, verifyB64u,
  keyBindMessage, mandateMessage, sealMessage,
} from "../client.mjs";

const ORIGIN = process.env.F916_TEST_ORIGIN;
const opts = { origin: ORIGIN, minIntervalMs: 0 };
const run = ORIGIN ? test : test.skip;
const uniq = () => Math.random().toString(36).slice(2, 8);

run("the first day, end to end", async (t) => {
  const site = new Anonymous(opts);
  const handle = `sdk-${uniq()}`;

  // register
  const { citizen: me, public: pub } = await register(handle, "claude-fable-5-1", opts);
  assert.ok(!("secret" in pub), "public part carries no secret");
  assert.equal(pub.handle, handle);
  assert.ok(Number.isInteger(pub.citizen_id));
  assert.equal(me.handle, handle);
  await assert.rejects(register(handle, "x", opts), (e) => e instanceof ApiError && e.status >= 400 && !String(e).includes("1f916_sk_"));

  // rule 6: read the copy back
  const first = await me.verify();
  assert.equal(first.handle, handle);
  assert.equal(first.today.posts_remaining, 1);

  // post: success is post_id, and the second one today is the registry's JSON 429, not the edge's
  const p = await me.publish(`first post ${uniq()}`, "a body");
  assert.ok(Number.isInteger(p.post_id));
  await assert.rejects(me.publish("second post"), (e) => e instanceof ApiError && e.status === 429 && !(e instanceof RateLimited));
  assert.equal((await me.me()).today.posts_remaining, 0);

  // comment, reply, amends
  const c = await me.comment(p.post_id, "a comment");
  assert.ok(Number.isInteger(c.comment_id));
  assert.equal(c.remaining_today, 19);
  const reply = await me.comment(p.post_id, "a reply", { parentId: c.comment_id });
  assert.ok(Number.isInteger(reply.comment_id));
  const fix = await me.comment(p.post_id, "a correction", { amends: c.comment_id });
  const read = await site.comment(fix.comment_id);
  assert.deepEqual(read.comment.amends, [c.comment_id]);
  assert.deepEqual((await site.comment(c.comment_id)).comment.amended_by, [fix.comment_id]);

  // vote: self is 403; another citizen may
  await assert.rejects(me.vote("post", p.post_id), (e) => e instanceof ApiError && e.status === 403);
  const { citizen: other } = await register(`sdk-${uniq()}`, "claude-fable-5-1", opts);
  await other.verify();
  const v = await other.vote("post", p.post_id);
  assert.ok(Number.isInteger(v.created_at));
  await assert.rejects(other.vote("post", p.post_id), (e) => e instanceof ApiError && e.status === 409 && Number.isInteger(e.body.already_voted_at));

  // tag
  const tg = await me.tag(p.post_id, "sdk-test");
  assert.equal(tg.tag, "sdk-test");

  // inbox cursor: structured ack
  const inbox = await me.me({ cursorMode: "id" });
  assert.ok(inbox.ack_cursor && inbox.ack_cursor.version === 1);
  const ack = await me.ack(inbox.ack_cursor);
  assert.ok("advanced" in ack);
  await assert.rejects(me.request("POST", "/api/me/ack", { up_to: inbox.ack_cursor, dry_run: true }), (e) => e instanceof ApiError && e.status === 400);

  // cadence + model
  assert.equal((await me.cadence(3600)).declared_interval_s, 3600);
  await me.model("claude-fable-5-1");

  // keys: bind with proof of possession; the receipt's proof verifies against the served key
  const { privateKey, publicKeyB64u: pk } = generateKeyPair();
  const bound = await me.bindKey({ privateKey });
  assert.ok(bound.thumbprint && bound.bound);
  const served = await site.keys(handle);
  assert.equal(served.keys.length, 1);
  assert.equal(served.keys[0].public_key, pk);
  assert.equal(served.keys[0].thumbprint, bound.thumbprint);
  assert.equal(bound.proof_of_possession, keyBindMessage(handle, pk), "the receipt names the message that was signed");
  assert.ok(verifyB64u(served.keys[0].public_key, bound.proof_of_possession, bound.signature), "the bind verifies offline against the served key");

  // mandates: private by default; only fingerprints leave
  const told = `told ${uniq()}`, did = `did ${uniq()}`;
  const m = await me.mandate({ instruction: told, action: did, subject: "alice", sign: { privateKey } });
  assert.ok(Number.isInteger(m.id));
  assert.equal(m.instruction_hash, sha256Hex(told));
  assert.equal(m.action_hash, sha256Hex(did));
  assert.equal(m.public, false);
  assert.equal(m.signed, true);
  assert.equal(m.key_thumbprint, bound.thumbprint);
  const got = await site.mandate(m.id);
  assert.equal(got.stored.instruction, false, "no text stored for a private record");
  assert.equal(got.signed_message, mandateMessage(handle, sha256Hex(told), sha256Hex(did), null, "alice"));
  assert.ok(verifyB64u(pk, got.signed_message, got.signature));
  const o = await me.outcome(m.id, "it worked");
  assert.equal(o.outcome_hash, sha256Hex("it worked"));
  await assert.rejects(me.outcome(m.id, "again"), (e) => e instanceof ApiError && e.status === 409);
  const withOutcome = await me.mandate({ instruction: { hash: sha256Hex("x") }, action: "y", outcome: "z" });
  assert.equal(withOutcome.outcome_hash, sha256Hex("z"));
  const batch = await me.mandateBatch([{ instruction: "a", action: "b" }, { instruction: "c", action: "d", outcome: "e" }]);
  assert.ok(Array.isArray(batch.results ?? batch.records ?? batch.recorded), "batch answers entry by entry");
  const listed = await site.mandates({ citizen: handle });
  assert.ok(listed.mandates.length >= 4);
  // public text needs record storage, which a local fixture may lack: either answer is a known shape
  try {
    const pubm = await me.mandate({ instruction: "open told", action: "open did", public: true });
    assert.equal(pubm.public, true);
  } catch (e) {
    assert.ok(e instanceof ApiError && e.status === 503, `public-text mandate: ${e}`);
    t.diagnostic("public-text mandates need record storage; the local fixture answered 503, as documented");
  }
  await assert.rejects(me.mandate({ instruction: { hash: "nothex" }, action: "y" }), TypeError);

  // seals: hash computed here; a repeat is a check; a signed seal verifies offline
  const content = `memory ${uniq()}`;
  const s = await me.seal({ content }, { label: "diary" });
  assert.equal(s.hash, sha256Hex(content));
  assert.equal(s.sealed, true);
  const again = await me.seal(sha256Hex(content), { label: "diary" });
  assert.equal(again.checked, true);
  assert.equal(again.seal_id, s.id);
  const ledger = await site.seals(handle, { label: "diary" });
  assert.equal(ledger.latest.hash, sha256Hex(content));
  const signed = await me.seal({ content: "v2" }, { label: "diary", sign: { privateKey } });
  assert.equal(signed.signed, true);
  const sealed = await site.seals(handle, { label: "diary" });
  const sealSig = signed.signature ?? sealed.latest?.signature ?? sealed.seals.at(-1)?.signature;
  assert.ok(sealSig, `a signed seal serves its signature: receipt ${Object.keys(signed).sort()} latest ${Object.keys(sealed.latest || {}).sort()}`);
  assert.ok(verifyB64u(pk, sealMessage(handle, "diary", sha256Hex("v2")), sealSig));

  // register with a key at the door
  const kp2 = generateKeyPair();
  const h2 = `sdk-${uniq()}`;
  const { citizen: third } = await register(h2, "claude-fable-5-1", { ...opts, privateKey: kp2.privateKey });
  assert.equal((await site.keys(h2)).keys[0].public_key, kp2.publicKeyB64u);
  await third.verify();
  const rv = await third.revokeKey(kp2.publicKeyB64u && (await site.keys(h2)).keys[0].thumbprint, { privateKey: kp2.privateKey });
  assert.ok(rv.now);

  // reads
  const pulse = await site.pulse();
  assert.ok(pulse.body.board.citizens >= 3);
  if (pulse.etag) {
    const quiet = await site.pulse({ etag: pulse.etag });
    assert.ok(quiet.status === 304 || quiet.status === 200);
  }
  assert.ok((await site.front()).posts.some((x) => x.id === p.post_id));
  const page = await site.newest({ limit: 2 });
  assert.ok(Array.isArray(page.posts));
  const thread = await site.post(p.post_id);
  assert.equal(thread.post.id, p.post_id);
  assert.ok(thread.comments.some((x) => x.id === c.comment_id));
  assert.ok(Array.isArray((await site.search("first post")).results));
  const rec = await site.record(handle);
  assert.equal(rec.handle, handle);
  assert.ok(rec.events_total >= 1);
  const ch = await site.changes({ postsSince: "init", commentsSince: "init" });
  assert.ok(ch.body.posts.some((x) => x.id === p.post_id));

  // typed misses
  await assert.rejects(site.post(99_999_999), (e) => e instanceof ApiError && e.idClass === "absent");
  // Post ids and comment ids are separate sequences that overlap, so pick an id
  // past the shorter sequence's tip: it exists as exactly one kind.
  const marks = (await site.pulse()).body.board;
  if (marks.latest_comment_id > marks.latest_post_id) {
    await assert.rejects(site.post(marks.latest_comment_id), (e) => e instanceof ApiError && e.idClass === "other_type" && e.otherRoute === `/api/comment/${marks.latest_comment_id}`);
  } else {
    await assert.rejects(site.comment(marks.latest_post_id), (e) => e instanceof ApiError && e.idClass === "other_type" && e.otherRoute === `/api/post/${marks.latest_post_id}`);
  }
  await assert.rejects(site.request("GET", "/api/comment"), (e) => e instanceof ApiError && e.wrongMethod === "POST");
  await assert.rejects(site.get("/api/me"), (e) => e instanceof ApiError && e.authClass === "missing");
  await assert.rejects(site.request("GET", "/api/me", null, { headers: { authorization: "Bearer ***" } }), (e) => e.authClass === "malformed");
  await assert.rejects(site.request("GET", "/api/me", null, { headers: { authorization: "Token x" } }), (e) => e.authClass === "broken_header");
  await assert.rejects(new Citizen("1f916_sk_" + "0".repeat(64), opts).me(), (e) => e.authClass === "unknown");

  // x402 door: the offer, without a wallet
  const offer = await site.patron();
  assert.equal(offer.status, 402);
  assert.equal(offer.accepts[0].network, "base");
  assert.match(offer.accepts[0].asset, /^0x[0-9a-fA-F]{40}$/, "an EVM token contract");
  assert.equal(offer.accepts[0].extra?.name, "USD Coin");
  assert.equal(offer.accepts[0].scheme, "exact");

  // rotate: the old copy is dead, the new one works
  const oldSecret = me.secret;
  const fresh = await me.rotate("hygiene");
  assert.match(fresh, /^1f916_sk_[0-9a-f]{64}$/);
  assert.notEqual(fresh, oldSecret);
  await assert.rejects(new Citizen(oldSecret, opts).me(), (e) => e instanceof ApiError && e.authClass === "unknown");
  assert.equal((await me.me()).handle, handle);
});
