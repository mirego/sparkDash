import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyModelType,
  MODEL_TYPES,
  EFFORT_VARIANTS,
  chatTemplateVariants,
  effortThinkingLevelMap,
  chatTemplateThinkingLevelMap,
  chatTemplateCompat,
  FLEET_BASE_URL,
  FLEET_API_KEY_PLACEHOLDER,
} from "../ExportModelSpec.js";

test("classifyModelType: exl3 quantization ⇒ chat-template", () => {
  assert.equal(classifyModelType({ quantization: "exl3", engine: "vllm" }), MODEL_TYPES.CHAT_TEMPLATE);
  assert.equal(classifyModelType({ quantization: "EXL3" }), MODEL_TYPES.CHAT_TEMPLATE);
});

test("classifyModelType: sglang ⇒ effort; vllm/unknown ⇒ effort default", () => {
  assert.equal(classifyModelType({ quantization: "nvfp4", engine: "sglang" }), MODEL_TYPES.EFFORT);
  assert.equal(classifyModelType({ engine: "vllm" }), MODEL_TYPES.EFFORT);
  assert.equal(classifyModelType({}), MODEL_TYPES.EFFORT);
  assert.equal(classifyModelType(null), MODEL_TYPES.EFFORT);
});

test("effort variants carry reasoningEffort only — no chat_template_kwargs", () => {
  for (const [k, v] of Object.entries(EFFORT_VARIANTS)) {
    assert.ok(["low", "medium", "high", "max"].includes(k), `level ${k}`);
    assert.equal(typeof v.reasoningEffort, "string");
    assert.equal(v.chat_template_kwargs, undefined);
  }
});

test("chat_template variants: none/low/high/max with enable_thinking mechanics", () => {
  const v = chatTemplateVariants();
  assert.deepEqual(Object.keys(v).sort(), ["high", "low", "max", "none"]);
  assert.deepEqual(v.none, { chat_template_kwargs: { enable_thinking: false } });
  assert.deepEqual(v.low, { chat_template_kwargs: { enable_thinking: true, reasoning_effort: "low" } });
  assert.deepEqual(v.high, { chat_template_kwargs: { enable_thinking: true, reasoning_effort: "high" } });
  assert.deepEqual(v.max, { chat_template_kwargs: { enable_thinking: true, reasoning_effort: "xhigh" } });
});

test("thinkingLevelMaps differ per model type and hide unsupported levels with null", () => {
  const effort = effortThinkingLevelMap();
  const chat = chatTemplateThinkingLevelMap();
  // Effort map is a 1:1 pass-through for the supported levels.
  assert.equal(effort.low, "low");
  assert.equal(effort.xhigh, "xhigh");
  assert.equal(effort.off, null);
  // Chat-template map: template validates {low, medium, xhigh} + off.
  assert.equal(chat.off, "off");
  assert.equal(chat.high, "xhigh"); // unsloth patch: high maps to xhigh
  assert.equal(chat.minimal, null);
  assert.equal(chat.max, null);
  assert.notDeepEqual(effort, chat);
});

test("chatTemplateCompat: pi-native qwen-chat-template mechanics", () => {
  const c = chatTemplateCompat();
  assert.equal(c.thinkingFormat, "qwen-chat-template");
  assert.equal(c.supportsReasoningEffort, false);
  assert.deepEqual(c.chatTemplateKwargs.enable_thinking, { $var: "thinking.enabled" });
  assert.deepEqual(c.chatTemplateKwargs.reasoning_effort, { $var: "thinking.effort", omitWhenOff: true });
});

test("fleet constants are the user-approved values", () => {
  assert.equal(FLEET_BASE_URL, "http://10.4.0.15:8317/v1");
  assert.equal(FLEET_API_KEY_PLACEHOLDER, "YOUR_API_KEY");
});
