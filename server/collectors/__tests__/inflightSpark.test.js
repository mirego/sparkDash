import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveInflightSparkId, requestBelongsToSpark } from "../../util/inflightSpark.js";

test("explicit sparkId wins over model sniffing", () => {
  assert.equal(resolveInflightSparkId({ sparkId: "son-of-anton", model: "anything" }), "son-of-anton");
  assert.equal(resolveInflightSparkId({ sparkId: "anton", model: "anything" }), "anton");
});

test("backend pin resolves to the right spark", () => {
  assert.equal(resolveInflightSparkId({ model: "x", backend: "@b:" }), "son-of-anton");
  assert.equal(resolveInflightSparkId({ model: "x", backend: "192.168.100.11" }), "son-of-anton");
  assert.equal(resolveInflightSparkId({ model: "x", backend: "@a:" }), "anton");
  assert.equal(resolveInflightSparkId({ model: "x", backend: "127.0.0.1" }), "anton");
});

test("son-of-anton model name resolves to son-of-anton", () => {
  assert.equal(resolveInflightSparkId({ model: "foo-son-of-anton", backend: null }), "son-of-anton");
});

test("head-only model names (DSpark/Inkling/deepseek) resolve to anton", () => {
  assert.equal(resolveInflightSparkId({ model: "deepseek-v4-flash-dspark", backend: null, sparkId: null }), "anton");
  assert.equal(resolveInflightSparkId({ model: "inkling-small", backend: null, sparkId: null }), "anton");
  assert.equal(resolveInflightSparkId({ model: "anything-dspark", backend: null, sparkId: null }), "anton");
});

test("gilfoyle-current-model — the special served-model alias — resolves to anton (regression)", () => {
  // Live requests via the served-model key carry model="gilfoyle-current-model"
  // and NO backend/sparkId. They must still show a pill on the head spark.
  assert.equal(
    resolveInflightSparkId({ model: "gilfoyle-current-model", backend: null, sparkId: null }),
    "anton",
  );
});

test("unknown model with no pin resolves to null (un-attributable, not hidden)", () => {
  assert.equal(resolveInflightSparkId({ model: "mystery-v2", backend: null, sparkId: null }), null);
  assert.equal(resolveInflightSparkId(null), null);
});

test("requestBelongsToSpark matches pinch + filters non-matching sparks", () => {
  const req = { model: "gilfoyle-current-model", backend: null, sparkId: null };
  assert.equal(requestBelongsToSpark(req, "anton"), true);
  assert.equal(requestBelongsToSpark(req, "son-of-anton"), false);
});
