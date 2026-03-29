import test from "node:test";
import assert from "node:assert/strict";

import { classifyRevert } from "./vaultAdapter.js";

test("classifyRevert treats short vault duplicate-position revert as abort", () => {
  const action = classifyRevert(new Error('execution reverted: "pos already open"'));
  assert.equal(action, "abort");
});
