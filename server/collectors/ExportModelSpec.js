/**
 * ExportModelSpec — shared per-model parameter derivation for the agent-CLI
 * config exports (opencode + pi-mono, story t_da2e5d5e).
 *
 * The active-model entry in both payloads must be VALIDATED PER MODEL, not
 * cloned from a template. The single classification axis is how the model
 * consumes thinking controls (verified live against the fleet + pi-mono docs):
 *
 *   - `effort`  — effort-capable models (sglang/qwen templates that accept a
 *     top-level `reasoning_effort`): opencode gets `variants` with
 *     `reasoningEffort`; pi-mono gets an effort-style `thinkingLevelMap`
 *     (nulls for unsupported levels).
 *   - `chat-template` — chat-template-gated models (exl3 quantized GLM served
 *     via vLLM, whose Jinja template reads `chat_template_kwargs`):
 *     opencode gets `variants` with `chat_template_kwargs {enable_thinking,
 *     reasoning_effort}`; pi-mono gets `compat.thinkingFormat:
 *     "qwen-chat-template"` + `chatTemplateKwargs` `$var` bindings + a
 *     chat-template `thinkingLevelMap` (pi.dev/docs custom-provider +
 *     soster/qwen38-thinking-levels config shape).
 *
 * The classifier is intentionally conservative: only signals present in the
 * live registry drive it. Unknown engines classify as `effort` (the safe
 * vLLM default — a top-level reasoning_effort is ignored harmlessly by
 * templates that don't read it, whereas wrong chat_template_kwargs can 400).
 */

/** Model types with distinct variant/thinking mechanics. */
export const MODEL_TYPES = {
  EFFORT: "effort",
  CHAT_TEMPLATE: "chat-template",
};

/**
 * Classify a registry model entry.
 * - quantization `exl3` ⇒ chat-template-gated (EXL3 served via vLLM reads
 *   `chat_template_kwargs` — the glm-5.3-exl3 case).
 * - engine `sglang` ⇒ effort-capable (qwen3.8-27b case).
 * - everything else (vllm/unknown) ⇒ effort-capable default.
 * @param {object} model registry model entry
 * @returns {"effort"|"chat-template"}
 */
export function classifyModelType(model) {
  if (typeof model?.quantization === "string" && model.quantization.toLowerCase() === "exl3") {
    return MODEL_TYPES.CHAT_TEMPLATE;
  }
  return MODEL_TYPES.EFFORT;
}

/** Fleet-wide baseline for `gilfoyle-current-model` (user-approved sample values). */
export const CURRENT_MODEL_BASELINE = Object.freeze({
  name: "Current model loaded on Gilfoyle",
  contextLimit: 1000000,
  outputLimit: 128000,
  opencodeModalities: Object.freeze({ input: ["text", "image", "video"], output: ["text"] }),
  pimonoInput: Object.freeze(["text", "image"]),
});

/** opencode reasoningEffort variants for effort-capable models. */
export const EFFORT_VARIANTS = Object.freeze({
  low: { reasoningEffort: "low" },
  medium: { reasoningEffort: "medium" },
  high: { reasoningEffort: "high" },
  max: { reasoningEffort: "max" },
});

/**
 * opencode chat_template_kwargs variants for chat-template-gated models.
 * Levels per the OPin sample: none/low/high/max (`medium` omitted — the exl3
 * GLM template validates {xhigh|medium|low} + off, and the sample set is the
 * product ruling).
 */
export function chatTemplateVariants() {
  const kwarg = (enableThinking, effort) => ({
    chat_template_kwargs: enableThinking === null
      ? { enable_thinking: false }
      : { enable_thinking: true, reasoning_effort: effort },
  });
  return {
    none: kwarg(null),
    low: kwarg(true, "low"),
    high: kwarg(true, "high"),
    max: kwarg(true, "xhigh"),
  };
}

/**
 * pi-mono thinkingLevelMap for effort-capable models: pi levels map 1:1 onto
 * reasoning_effort values; levels the model can't express are null (hidden
 * from pi's picker).
 */
export function effortThinkingLevelMap() {
  return {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  };
}

/**
 * pi-mono thinkingLevelMap for chat-template-gated models. The template
 * validates reasoning_effort ∈ {low, medium, xhigh} plus enable_thinking:false
 * (rendered by pi's `off`), so `high` maps to xhigh per the unsloth patch and
 * the rest are hidden.
 */
export function chatTemplateThinkingLevelMap() {
  return {
    off: "off",
    minimal: null,
    low: "low",
    medium: "medium",
    high: "xhigh",
    xhigh: "xhigh",
    max: null,
  };
}

/** pi-mono compat block for chat-template-gated models (pi-native equivalent). */
export function chatTemplateCompat() {
  return {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    thinkingFormat: "qwen-chat-template",
    chatTemplateKwargs: {
      enable_thinking: { $var: "thinking.enabled" },
      reasoning_effort: { $var: "thinking.effort", omitWhenOff: true },
    },
  };
}

/** Fleet endpoint constants (user-approved literal placeholder — t_da2e5d5e). */
export const FLEET_BASE_URL = "http://10.4.0.15:8317/v1";
export const FLEET_API_KEY_PLACEHOLDER = "YOUR_API_KEY";
