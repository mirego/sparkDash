import { act } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({
  fetchLaunchers: () => new Promise(() => {}),
  runLauncher: vi.fn(),
  wakeSpark: vi.fn(),
}));

import { SparkCard } from "./SparkCard";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";
import type { SparkSnapshot } from "../../api/types";

function worker(): SparkSnapshot {
  return { ...makeSpark("w"), role: "worker", workerNode: true, workerHeadId: "h", workerLabel: "cfg-label" } as SparkSnapshot;
}
function head(online: boolean): SparkSnapshot {
  const h = makeSpark("h", online);
  return {
    ...h,
    role: "head",
    metrics: { ...h.metrics, llm: [{ available: true, backend: "vllm", modelId: "big-model", generationTps: 12, prefillTps: 100, contextLength: 4096 }] },
  } as unknown as SparkSnapshot;
}

describe("SparkCard", () => {
  it.each([null, undefined, 0, 2])("renders queue %s without inventing a zero", (waiting) => {
    const spark = makeSpark("fixture");
    Object.assign(spark.metrics.llm[0], {
      backend: "tensorfold", slotsActive: 8, slotsTotal: 8,
      requestsRunning: 8, requestsWaiting: waiting,
    });
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    expect(container.querySelector(".ov-chips")?.textContent).toContain(
      waiting == null ? "8 running · queue unknown" : `8 running · ${waiting} queued`
    );
  });

  it("renders unknown slot occupancy without presenting it as zero", () => {
    const spark = makeSpark("fixture");
    Object.assign(spark.metrics.llm[0], {
      backend: "tensorfold", slotsActive: null, slotsTotal: 8, requestsRunning: null,
    });
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    expect(container.querySelector(".ov-chips")?.textContent).toContain("?/8 slots");
  });
  it("lists private loaded models alongside the monitored model without duplicates", () => {
    const spark = head(true);
    spark.metrics.residentModels = [
      { modelId: "big-model", container: "primary-vllm" },
      { modelId: "datalab-to/surya-ocr-2", container: "surya-vllm" },
    ];
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    const rows = [...container.querySelectorAll(".ov-modelrow code")].map((row) => row.textContent);
    expect(rows).toEqual(["big-model", "datalab-to/surya-ocr-2"]);
    expect(container.querySelectorAll(".ov-modelrow")[1].textContent).toContain("Loaded");
  });

  it("does not present an offline unit's discovered models as loaded", () => {
    const spark = head(false);
    spark.metrics.residentModels = [{ modelId: "surya-private", container: "surya-vllm" }];
    const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
    expect(container.textContent).not.toContain("surya-private");
  });
  it("is a plain container whose name is the only link; no interactive element nests another", () => {
    const onSelect = vi.fn();
    const { container } = render(<SparkCard spark={makeSpark("a")} temperatureUnit="celsius" onSelect={onSelect} />);
    const card = container.querySelector(".ov-sc")!;
    expect(card.getAttribute("role")).toBeNull();
    expect(card.getAttribute("tabindex")).toBeNull();
    const link = card.querySelector<HTMLAnchorElement>("a.ov-sc__link")!;
    expect(link.textContent).toBe("Spark a");
    for (const el of card.querySelectorAll("button, a, [role=button]")) {
      expect(el.querySelector("button, a, [role=button]")).toBeNull();
    }
    act(() => link.click());
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("does not select when clicking the card body (only the stretched name does)", () => {
    const onSelect = vi.fn();
    const { container } = render(<SparkCard spark={makeSpark("a")} temperatureUnit="celsius" onSelect={onSelect} />);
    act(() => container.querySelector<HTMLElement>(".ov-sc__body")?.click());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a worker shows its online head's model", () => {
    const { container } = render(<SparkCard spark={worker()} headSpark={head(true)} temperatureUnit="celsius" />);
    expect(container.textContent).toContain("big-model");
  });

  it("a worker does not show an offline head's stale model", () => {
    const { container } = render(<SparkCard spark={worker()} headSpark={head(false)} temperatureUnit="celsius" />);
    expect(container.textContent).not.toContain("big-model");
    expect(container.textContent).toContain("cfg-label");
    expect(container.textContent).toContain("Head is offline");
  });

  describe("per-key in-flight pills", () => {
    const req = (id: string, phase: string, completionEstTokens = 1200, promptEstTokens = 3000) => ({
      id,
      phase,
      model: "fixture-model",
      promptEstTokens,
      completionEstTokens,
      cachedTokens: null,
      ageSec: 14,
    });
    function sparkWithReqs(users: Array<{ label: string; openRequests: unknown[] }>): SparkSnapshot {
      const s = makeSpark("a");
      (s.metrics.llm[0] as unknown as Record<string, unknown>).activeUsers = users;
      return s;
    }

    it("cumulates same-key requests into ONE pill with ×N, summed tokens and input shown", () => {
      const spark = sparkWithReqs([
        { label: "sbre", openRequests: [req("r1", "streaming"), req("r2", "streaming"), req("r3", "waiting")] },
        { label: "other-key", openRequests: [req("r4", "streaming", 900)] },
      ]);
      const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
      const pills = container.querySelectorAll('[data-testid="inflight-req-pills"] .tag');
      // One pill PER KEY — same-key requests never repeat the label.
      expect(pills).toHaveLength(2);
      const labels = Array.from(pills).map((p) => p.textContent);
      expect(labels[0]).toMatch(/^sbre ×3 · in 9\.0k · out 3\.6k · 14s$/);
      expect(labels[1]).toMatch(/^other-key · in 3\.0k · out 900 · 14s$/);
      // Pre-byte request in the bundle → warning tone, streaming-only → success.
      expect(pills[0].className).toContain("tag--warn");
      expect(pills[1].className).toContain("tag--good");
    });

    it("shows summed input tokens on the pill and per-request detail in the tooltip", () => {
      const spark = sparkWithReqs([
        {
          label: "jaub",
          openRequests: [
            { ...req("r1", "streaming", 500, 1500), cachedTokens: 1000 },
            { ...req("r2", "streaming", 500, 2500), ageSec: 30 },
          ],
        },
      ]);
      const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
      const pill = container.querySelector('[data-testid="inflight-req-pills"] .tag')!;
      // 1500 + 2500 prompt tokens, summed with cached split out.
      expect(pill.textContent).toMatch(/in 4\.0k \(1\.0k cached · 25%\) · out 1\.0k · 30s/);
      // Tooltip carries one bullet line per underlying request.
      const title = pill.getAttribute("title") ?? "";
      expect(title).toContain("jaub ×2");
      expect(title).toContain("• streaming · in 1.5k (1.0k cached) · out 500 · 14s");
      expect(title).toContain("• streaming · in 2.5k · out 500 · 30s");
    });

    it("cumulates a same-key burst into a single ×N pill (no +N overflow when under max keys)", () => {
      const spark = sparkWithReqs([
        { label: "burst", openRequests: Array.from({ length: 8 }, (_, i) => req(`r${i}`, "streaming")) },
      ]);
      const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
      const pills = container.querySelectorAll('[data-testid="inflight-req-pills"] .tag');
      // All 8 requests share one key -> ONE cumulated pill, nothing hidden.
      expect(pills).toHaveLength(1);
      expect(pills[0].textContent).toMatch(/^burst ×8 · in 24k · out 9\.6k · 14s$/);
    });

    it("renders pill labels from the api-key prefix only, never a full key (d-002)", () => {
      const spark = sparkWithReqs([
        {
          // Prefix form: `sbre` is the masked prefix; a full key would look
          // like `sbre-<secret>` and must never reach a pill label.
          label: "sbre",
          openRequests: [req("r1", "streaming"), req("r2", "streaming")],
        },
      ]);
      const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
      const pills = [...container.querySelectorAll('[data-testid="inflight-req-pills"] .tag')];
      expect(pills).toHaveLength(1);
      const label = pills[0].textContent ?? "";
      // Label is the prefix form (×N cumulation + token/age suffix), not the
      // `<prefix>-<secret>` full-key shape.
      expect(label.startsWith("sbre ×")).toBe(true);
      expect(label.startsWith("sbre-")).toBe(false);
    });

    it("renders no pill row when there is no in-flight traffic", () => {
      const { container } = render(<SparkCard spark={makeSpark("a")} temperatureUnit="celsius" />);
      expect(container.querySelector('[data-testid="inflight-req-pills"]')).toBeNull();
    });
  });
});
