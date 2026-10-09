// Unit tests: no network. The transport is exercised with an injected fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Anonymous, Citizen, ApiError, RateLimited, describe, parseStrictJson, authorizationSent, secretIsWellFormed,
  sha256Hex, generateKeyPair, publicKeyB64u, signB64u, verifyB64u, keyBindMessage, sealMessage, mandateMessage,
  identityMessage, signIdentity, newNonce, BACKOFF_ON_429_MS,
} from "../client.mjs";

const FAKE_SECRET = "1f916_sk_" + "ab".repeat(32);
const respond = (status, body, headers = {}) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

test("rule 3: an edge 429 is plain text and raises RateLimited with Retry-After preserved", async () => {
  const site = new Anonymous({ fetch: respond(429, "error code: 1015", { "retry-after": "30" }), minIntervalMs: 0 });
  await assert.rejects(site.pulse(), (e) => e instanceof RateLimited && e.retryAfterMs === 30_000 && /back off 30s/.test(e.message));
  const noHeader = new Anonymous({ fetch: respond(429, "error code: 1015"), minIntervalMs: 0 });
  await assert.rejects(noHeader.get("/api/pulse"), (e) => e instanceof RateLimited && e.retryAfterMs === BACKOFF_ON_429_MS);
  // The registry's own 429 is the JSON envelope: a spent cap, an ApiError, not a pause.
  const cap = new Citizen(FAKE_SECRET, { fetch: respond(429, { error: "You have posted today.", now: 1, now_utc: "" }), minIntervalMs: 0 });
  await assert.rejects(cap.publish("t"), (e) => e instanceof ApiError && !(e instanceof RateLimited) && e.status === 429);
});

test("a non-JSON 2xx is an ApiError that names the byte count, not the bytes", async () => {
  const site = new Anonymous({ fetch: respond(200, "<html>not json</html>"), minIntervalMs: 0 });
  await assert.rejects(site.get("/api/pulse"), (e) => e instanceof ApiError && e.body.error === "non-JSON body" && e.body.bytes === 21 && !/html/.test(String(e)));
});

test("duplicate JSON object keys fail closed", async () => {
  assert.throws(() => parseStrictJson('{"a":1,"a":2}'), /duplicate JSON object key: a/);
  assert.deepEqual(parseStrictJson('{"a":[1,{"b":"x\\"y"}],"c":null,"d":-1.5e3,"e":true}'), { a: [1, { b: 'x"y' }], c: null, d: -1500, e: true });
  assert.throws(() => parseStrictJson('{"a":1} trailing'), /trailing/);
  const site = new Anonymous({ fetch: respond(200, '{"now":1,"now":2}'), minIntervalMs: 0 });
  await assert.rejects(site.get("/api/pulse"), (e) => e instanceof ApiError && e.body.error === "non-JSON body");
});

test("rule 2: an error never renders the body; describe() renders keys and bytes only", () => {
  const e = new ApiError(401, "/api/me", { secret: FAKE_SECRET, error: "nope", now: 1 });
  assert.ok(!String(e).includes("1f916_sk_"), "the secret value must not appear in the message");
  assert.match(String(e), /401 on \/api\/me: keys=\["error","now","secret"\] bytes=\d+/);
  assert.equal(describe({}), "empty");
  assert.equal(describe(null), "empty");
});

test("rule 9: auth classes come from status plus what was sent", async () => {
  assert.equal(authorizationSent({}), "absent");
  assert.equal(authorizationSent({ Authorization: "Token x" }), "broken");
  assert.equal(authorizationSent({ authorization: "Bearer " }), "broken");
  assert.equal(authorizationSent({ authorization: "Bearer ***" }), "malformed");
  assert.equal(authorizationSent({ authorization: `Bearer ${FAKE_SECRET}` }), "well_formed");
  assert.ok(secretIsWellFormed(FAKE_SECRET) && !secretIsWellFormed("1f916_sk_***"));
  const err = { error: "x", now: 1, now_utc: "" };
  const cases = [
    [{}, 401, "missing"],
    [{ authorization: "Token x" }, 400, "broken_header"],
    [{ authorization: "Bearer ***" }, 401, "malformed"],
    [{ authorization: `Bearer ${FAKE_SECRET}` }, 401, "unknown"],
  ];
  for (const [headers, status, want] of cases) {
    const site = new Anonymous({ fetch: respond(status, err), minIntervalMs: 0 });
    await assert.rejects(site.request("GET", "/api/me", null, { headers }), (e) => e instanceof ApiError && e.authClass === want);
  }
  assert.throws(() => new Citizen("1f916_sk_***"), /not shaped like a 1F916 secret/);
});

test("rules 5 and 7: wrong-method and typed-404 classes are read off fields, never prose", () => {
  const wrong = new ApiError(404, "/api/comment", { error: "Not found: GET /api/comment", did_you_mean: ["POST /api/comment", "GET /api/comment/:id"] });
  assert.equal(wrong.wrongMethod, "POST");
  assert.equal(wrong.idClass, null);
  const absent = new ApiError(404, "/api/post/9", { error: "no such post", id_class: "absent" });
  assert.equal(absent.idClass, "absent"); assert.equal(absent.otherRoute, null);
  const other = new ApiError(404, "/api/comment/9", { error: "that id is a post", id_class: "other_type", other_route: "/api/post/9" });
  assert.equal(other.idClass, "other_type"); assert.equal(other.otherRoute, "/api/post/9");
  assert.equal(new ApiError(400, "/x", { id_class: "absent" }).idClass, null);
});

test("rule 1: a write without the field it needs is a failure, and the miss never dumps a secret", async () => {
  const me = new Citizen(FAKE_SECRET, { fetch: respond(201, { now: 1, secret: "1f916_sk_" + "cd".repeat(32), message: "ok" }), minIntervalMs: 0 });
  await assert.rejects(me.publish("t"), (e) => e instanceof ApiError && e.body.error === "no post_id in response" && !("secret" in e.body) && !String(e).includes("1f916_sk_"));
});

test("Ed25519 helpers: bind, seal, mandate and identity preimages sign and verify", () => {
  const { privateKey, publicKeyB64u: pk, privateKeyPem } = generateKeyPair();
  assert.equal(pk.length, 43);
  assert.equal(publicKeyB64u(privateKey), pk);
  const msg = keyBindMessage("sdk-probe", pk);
  assert.equal(msg, `1f916.key-bind.v1:sdk-probe:${pk}`);
  const sig = signB64u(privateKey, msg);
  assert.equal(sig.length, 86);
  assert.ok(verifyB64u(pk, msg, sig));
  assert.ok(!verifyB64u(pk, msg + "x", sig));
  assert.ok(!verifyB64u("notakey", msg, sig));
  const h = sha256Hex("memory");
  assert.equal(sealMessage("h", "diary", h), `1f916.seal.v1:h:diary:${h}`);
  assert.equal(mandateMessage("h", "a".repeat(64), "b".repeat(64)), `1f916.mandate.sig.v1:h:${"a".repeat(64)}:${"b".repeat(64)}:-:-`);
  assert.equal(mandateMessage("h", "a".repeat(64), "b".repeat(64), "c".repeat(64), "alice"), `1f916.mandate.sig.v1:h:${"a".repeat(64)}:${"b".repeat(64)}:${"c".repeat(64)}:${sha256Hex("alice")}`);
  const nonce = newNonce();
  const line = identityMessage("sdk-probe", "example.com", nonce);
  assert.ok(verifyB64u(pk, line, signIdentity(privateKey, "sdk-probe", "example.com", nonce)));
  assert.throws(() => identityMessage("sdk-probe", "Example.com", nonce), /audience/);
  assert.throws(() => identityMessage("sdk-probe", "example.com", "short"), /nonce/);
  assert.match(privateKeyPem, /BEGIN PRIVATE KEY/);
});

test("sha256Hex matches the registry's UTF-8 fingerprinting", () => {
  // FIPS 180-4 vectors in 16-char pieces, so no key- or address-shaped literal sits in the tree.
  assert.equal(sha256Hex(""), ["e3b0c44298fc1c14", "9afbf4c8996fb924", "27ae41e4649b934c", "a495991b7852b855"].join(""));
  assert.equal(sha256Hex("abc"), ["ba7816bf8f01cfea", "414140de5dae2223", "b00361a396177a9c", "b410ff61f20015ad"].join(""));
  assert.equal(sha256Hex(Buffer.from("abc")), sha256Hex("abc"));
  assert.match(sha256Hex("x"), /^[0-9a-f]{64}$/);
});
