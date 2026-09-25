/**
 * Issue #108: an explicit NAD_POLICY that names a missing file used to start the agent with no
 * limits and no allowlist at all.
 *
 * The distinction these tests pin is not "does the file exist" but "did anybody ask for it".
 * A default that is absent stays optional, because that is the documented way to run without a
 * policy; a nonempty NAD_POLICY is an operator choosing a file, and a typo in it must stop the
 * agent rather than quietly remove every rule. Offline throughout: no wallet, no network.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPolicy } from "../src/policy.mjs";

const DIR = mkdtempSync(join(tmpdir(), "nad-policy-override-"));
const MISSING = join(DIR, "not-here.json");
const VALID = join(DIR, "valid.json");
const BROKEN = join(DIR, "broken.json");
writeFileSync(VALID, JSON.stringify({ maxPerSend: "0.5" }));
writeFileSync(BROKEN, "{ not json");

const previous = process.env.NAD_POLICY;
const restore = () => {
  if (previous === undefined) delete process.env.NAD_POLICY;
  else process.env.NAD_POLICY = previous;
};

describe("loadPolicy — an explicit override that is not there", () => {
  afterEach(restore);

  it("refuses a missing file the operator named, and names it", () => {
    process.env.NAD_POLICY = MISSING;
    assert.throws(() => loadPolicy(), (err) => {
      assert.match(err.message, /does not exist/);
      assert.ok(err.message.includes(MISSING), `the path has to be in the message: ${err.message}`);
      return true;
    });
  });

  it("still returns null when nobody named a file", () => {
    // The documented way to run without limits: no override, and the default is absent. This is
    // the behaviour the refusal above must not swallow.
    delete process.env.NAD_POLICY;
    assert.equal(loadPolicy(join(DIR, "no-default-here", "policy.json")), null);
  });

  it("treats an empty or blank override as no override", () => {
    for (const value of ["", "   "]) {
      process.env.NAD_POLICY = value;
      assert.equal(loadPolicy(join(DIR, "no-default-here", "policy.json")), null);
    }
  });

  it("still loads an override that exists", () => {
    process.env.NAD_POLICY = VALID;
    const policy = loadPolicy();
    assert.equal(policy.path, VALID);
    assert.ok(policy.maxPerSend > 0n);
  });

  it("still reports a malformed override as malformed, not as missing", () => {
    process.env.NAD_POLICY = BROKEN;
    assert.throws(() => loadPolicy(), /not valid JSON/);
  });

  it("treats a dangling symlink as missing", (t) => {
    const link = join(DIR, "dangling.json");
    try {
      symlinkSync(join(DIR, "target-that-never-existed.json"), link);
    } catch {
      // Windows refuses symlinks without privileges; the branch is the same ENOENT either way.
      t.skip("symlinks unavailable on this platform");
      return;
    }
    process.env.NAD_POLICY = link;
    assert.throws(() => loadPolicy(), /does not exist/);
  });

  it("keeps the older contract for an explicit argument", () => {
    // Callers that pass a path have always owned the consequences, and the existing suite
    // depends on it. Only the environment override changed meaning.
    delete process.env.NAD_POLICY;
    assert.equal(loadPolicy(MISSING), null);
  });
});

describe("startup — the refusal happens before the wallet", () => {
  it("exits nonzero and never initialises the wallet", () => {
    const cli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
    const env = { ...process.env, NAD_POLICY: MISSING, NO_COLOR: "1" };
    delete env.NAD_CLI_NO_RUN;

    let status = 0;
    let output = "";
    try {
      output = execFileSync(process.execPath, [cli], {
        env, input: "", encoding: "utf8", timeout: 120000, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      status = err.status;
      output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }

    assert.equal(status, 1, `expected exit 1, transcript:\n${output}`);
    assert.match(output, /does not exist/);
    // The ordering is the point: a policy the operator meant to apply must stop the run before
    // anything can be signed, so the wallet line must never appear.
    assert.doesNotMatch(output, /initializing wallet/i);
  });
});
