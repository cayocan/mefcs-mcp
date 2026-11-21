import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAllowedUrl } from "../src/util/open-url.js";
import { Tone3000Client, MissingCredentialsError, LoginRequiredError } from "../src/tone3000/client.js";

test("only TONE3000 https URLs can be opened", () => {
  assert.ok(isAllowedUrl("https://www.tone3000.com/settings"));
  assert.ok(isAllowedUrl("https://www.tone3000.com/activate?user_code=ABCD-EFGH"));
  assert.ok(!isAllowedUrl("http://www.tone3000.com/settings"));
  assert.ok(!isAllowedUrl("https://evil.example.com/?x=tone3000.com"));
  assert.ok(!isAllowedUrl("file:///C:/Windows/System32/calc.exe"));
});

test("missing keys -> MissingCredentialsError; saved client id -> LoginRequiredError", async () => {
  const dir = mkdtempSync(join(tmpdir(), "t3k-"));
  const c = new Tone3000Client({ tokenFile: join(dir, "tokens.json"), configFile: join(dir, "config.json") });
  assert.equal(c.authMode, "none");
  await assert.rejects(() => c.search({ query: "twin" }), MissingCredentialsError);
  c.setCredentials({ clientId: "pk_test_1234567890" });
  assert.equal(c.authMode, "device-flow");
  assert.equal(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).tone3000ClientId, "pk_test_1234567890");
  await assert.rejects(() => c.search({ query: "twin" }), LoginRequiredError);
  assert.throws(() => c.setCredentials({ apiKey: "not-a-secret" }));
  // a new instance reads the saved key
  const c2 = new Tone3000Client({ tokenFile: join(dir, "tokens.json"), configFile: join(dir, "config.json") });
  assert.equal(c2.authMode, "device-flow");
});
