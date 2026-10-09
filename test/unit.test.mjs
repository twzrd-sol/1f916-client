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

test("rule 3: the three 429s are told apart from the response alone, with the evidence they were judged from", async () => {
  const run = (body, headers) => new Anonymous({ fetch: respond(429, body, headers), minIntervalMs: 0 }).pulse().then(() => null, (e) => e);
  const stamped = { error: "Daily post spent. One post per UTC day.", now: 1, now_utc: "1970-01-01T00:00:00.001Z" };

  // (1) the edge: plain text 1015 plus Retry-After -> a pause for that interval, safe to repeat
  const edge = await run("error code: 1015", { "retry-after": "30", "content-type": "text/plain; charset=UTF-8" });
  assert.ok(edge instanceof RateLimited && edge.source === "edge" && edge.retryAfterMs === 30_000 && edge.safeToRepeat);
  assert.deepEqual(edge.evidence, { status: 429, contentType: "text/plain; charset=UTF-8", retryAfter: "30", edgeMarker: "error code: 1015", source: "edge" });
  assert.match(edge.message, /back off 30s/);
  //     the edge without Retry-After falls back to the 10 s mitigation window
  const edgeBare = await run("error code: 1015");
  assert.ok(edgeBare instanceof RateLimited && edgeBare.source === "edge" && edgeBare.retryAfterMs === BACKOFF_ON_429_MS && edgeBare.evidence.retryAfter === null);

  // (2) the registry: the stamped JSON envelope -> a spent day, an ApiError, never a RateLimited
  const reg = await run(stamped, { "content-type": "application/json" });
  assert.ok(reg instanceof ApiError && !(reg instanceof RateLimited) && reg.status === 429);
  assert.equal(reg.rateLimitSource, "registry");
  assert.equal(reg.evidence.source, "registry");
  assert.equal(new ApiError(404, "/x", {}).rateLimitSource, null);

  // (3) neither: no pause interval to trust, and a write must not be blindly repeated
  const generic = [
    ["a gateway's plain text", "Too Many Requests", { "retry-after": "7" }],
    ["an empty body", "", {}],
    ["JSON with an error string but no registry stamp", { error: "slow down" }, {}],
    ["JSON with a stamp but no error sentence", { now: 1, now_utc: "x" }, {}],
    ["a JSON array", [1, 2], {}],
    ["a body that only mentions the edge marker", "retry later: error code: 1015 (see docs)", {}],
    ["an unparseable Retry-After on the edge's page is the edge, not unknown", "error code: 1015", { "retry-after": "soon" }],
  ];
  for (const [why, body, headers] of generic) {
    const e = await run(body, headers);
    if (why.startsWith("an unparseable")) {
      assert.ok(e instanceof RateLimited && e.source === "edge" && e.retryAfterMs === BACKOFF_ON_429_MS && e.evidence.retryAfter === "soon", why);
      continue;
    }
    assert.ok(e instanceof RateLimited && e.source === "unknown" && !e.safeToRepeat, why);
    assert.match(e.message, /source unknown/, why);
    assert.match(e.message, /do not repeat a write blindly/, why);
    assert.equal(e.evidence.source, "unknown", why);
    assert.equal(e.evidence.edgeMarker, null, why);
    assert.equal(e.retryAfterMs, headers["retry-after"] === "7" ? 7000 : null, why);
  }
  // a generic 429 on a WRITE through a Citizen is the same class: nothing is retried, the write is not assumed to have run
  const me = new Citizen(FAKE_SECRET, { fetch: respond(429, "Too Many Requests"), minIntervalMs: 0 });
  await assert.rejects(me.publish("t"), (e) => e instanceof RateLimited && e.source === "unknown" && !e.safeToRepeat);
  let calls = 0;
  const counting = new Citizen(FAKE_SECRET, { fetch: async () => { calls++; return new Response("Too Many Requests", { status: 429 }); }, minIntervalMs: 0 });
  await assert.rejects(counting.publish("t"));
  assert.equal(calls, 1, "the client never retries");
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
