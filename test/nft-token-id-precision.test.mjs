/**
 * Issue #106: a JSON number loses token-id precision before the uint256 guard from #105 sees it.
 *
 * The loss happens inside JSON.parse, so no code here can recover it: 9007199254740993 is already
 * 9007199254740992 by the time parseAction returns, and String() then hands the wallet an
 * ordinary-looking decimal id. These tests pin the refusal, where it happens, and the fact that
 * the legal range did not shrink with it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";

import { parseAction, runAction } from "../src/tools.mjs";
import { buildNftTransferCalldata, ERC721_ABI, transferNft } from "../src/wallet.mjs";

const TO = "0x0000000000000000000000000000000000000002";
const CONTRACT = "0x0000000000000000000000000000000000000003";
const RESOLVED = { ok: true, address: TO, name: null };

/** The first integer a double cannot hold, and the value it collapses to. */
const UNSAFE_ID = 9007199254740993;
const COLLAPSED = "9007199254740992";

describe("transfer_nft — numeric token ids past the safe-integer range", () => {
  it("refuses the id from the issue before the wallet is called", async () => {
    // The model output verbatim from #106.
    const action = parseAction(
      `{"action":"transfer_nft","to":"${TO}","contractAddress":"${CONTRACT}",` +
        `"tokenId":${UNSAFE_ID}}`,
    );
    // Precondition, not an assertion about our code: the parse already lost the digit. If this
    // ever fails, the premise of the whole fix changed and the rest of the file is meaningless.
    assert.equal(action.tokenId, 9007199254740992);

    const calls = [];
    const res = await runAction(action, RESOLVED, {
      transferNft: async (...args) => {
        calls.push(args);
        return { dryRun: true, fee: 0n };
      },
    });

    assert.match(String(res), /refused/i);
    // The point of the issue: refusing after String() would read the same to an operator and
    // still sign a transfer of the wrong token. Ordering is the fix, so ordering is the test.
    assert.deepEqual(calls, [], "the wallet must not be reached with a collapsed id");
  });

  it("refuses the same number arriving as a native tool argument", async () => {
    // The other way in: a native tool call hands runAction an action object directly, with a
    // real JS number rather than text that went through parseAction. Same boundary, same
    // refusal, and the wallet is still not reached.
    const calls = [];
    const res = await runAction(
      { action: "transfer_nft", to: TO, contractAddress: CONTRACT, tokenId: UNSAFE_ID },
      RESOLVED,
      {
        transferNft: async (...args) => {
          calls.push(args);
          return { dryRun: true, fee: 0n };
        },
      },
    );

    assert.match(String(res), /refused/i);
    assert.match(String(res), /decimal or hex string/i, "the refusal has to name the way out");
    assert.deepEqual(calls, []);
  });

  it("keeps accepting the largest id a JSON number does carry", async () => {
    const calls = [];
    const res = await runAction(
      { action: "transfer_nft", to: TO, contractAddress: CONTRACT, tokenId: Number.MAX_SAFE_INTEGER },
      RESOLVED,
      {
        transferNft: async (...args) => {
          calls.push(args);
          return { dryRun: true, fee: 0n };
        },
      },
    );

    assert.doesNotMatch(String(res), /refused/i);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][2], "9007199254740991");
  });

  it("accepts the same id as a string, because a string never lost anything", async () => {
    const calls = [];
    await runAction(
      { action: "transfer_nft", to: TO, contractAddress: CONTRACT, tokenId: "9007199254740993" },
      RESOLVED,
      {
        transferNft: async (...args) => {
          calls.push(args);
          return { dryRun: true, fee: 0n };
        },
      },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0][2], "9007199254740993");
  });
});

describe("wallet helpers — the same rule at the exported boundary", () => {
  it("buildNftTransferCalldata refuses an unsafe number", () => {
    assert.throws(
      () => buildNftTransferCalldata(TO, TO, UNSAFE_ID),
      /refused/i,
      "a number that cannot hold the id it was written as is not an id",
    );
  });

  it("transferNft refuses an unsafe number before it needs a session", async () => {
    // #105 moved the id check ahead of the session check precisely so this is reachable.
    await assert.rejects(() => transferNft(TO, CONTRACT, UNSAFE_ID), /refused/i);
  });

  it("an exact large string still encodes unchanged", () => {
    const data = buildNftTransferCalldata(TO, TO, "9007199254740993");
    const [, , decoded] = new Interface(ERC721_ABI).decodeFunctionData("safeTransferFrom", data);

    assert.equal(decoded.toString(), "9007199254740993");
    assert.notEqual(decoded.toString(), COLLAPSED);
  });

  it("the full uint256 range is still legal as a string", () => {
    const max = (2n ** 256n - 1n).toString();
    const data = buildNftTransferCalldata(TO, TO, max);
    const [, , decoded] = new Interface(ERC721_ABI).decodeFunctionData("safeTransferFrom", data);

    assert.equal(decoded.toString(), max);
  });

  it("0 and a safe integer are still ids", () => {
    for (const id of [0, 1, Number.MAX_SAFE_INTEGER]) {
      const data = buildNftTransferCalldata(TO, TO, id);
      const [, , decoded] = new Interface(ERC721_ABI).decodeFunctionData("safeTransferFrom", data);
      assert.equal(decoded.toString(), String(id));
    }
  });
});
