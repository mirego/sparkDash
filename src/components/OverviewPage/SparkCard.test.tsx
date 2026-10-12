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

  describe("per-request in-flight pills", () => {
    const req = (id: string, phase: string, completionEstTokens = 1200) => ({
      id,
      phase,
      model: "fixture-model",
      promptEstTokens: 3000,
      completionEstTokens,
      cachedTokens: null,
      ageSec: 14,
    });
    function sparkWithReqs(users: Array<{ label: string; openRequests: unknown[] }>): SparkSnapshot {
      const s = makeSpark("a");
      (s.metrics.llm[0] as unknown as Record<string, unknown>).activeUsers = users;
      return s;
    }

    it("renders one pill per open request, repeating the key for multiple requests", () => {
      const spark = sparkWithReqs([
        { label: "sbre", openRequests: [req("r1", "streaming"), req("r2", "streaming"), req("r3", "waiting")] },
        { label: "other-key", openRequests: [req("r4", "streaming", 900)] },
      ]);
      const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
      const pills = container.querySelectorAll('[data-testid="inflight-req-pills"] .tag');
      expect(pills).toHaveLength(4);
      const labels = Array.from(pills).map((p) => p.textContent);
      // One pill PER REQUEST: the same key prefix appears once per open request.
      expect(labels.filter((t) => t?.startsWith("sbre"))).toHaveLength(3);
      expect(labels.filter((t) => t?.startsWith("other-key"))).toHaveLength(1);
      expect(labels[0]).toMatch(/^sbre · streaming · out 1\.2k · 14s$/);
      // Pre-byte request gets the warning tone, streaming gets success.
      expect(pills[2].className).toContain("tag--warn");
      expect(pills[0].className).toContain("tag--good");
    });

    it("caps visible pills and falls back to +N more", () => {
      const spark = sparkWithReqs([
        { label: "burst", openRequests: Array.from({ length: 8 }, (_, i) => req(`r${i}`, "streaming")) },
      ]);
      const { container } = render(<SparkCard spark={spark} temperatureUnit="celsius" />);
      const pills = container.querySelectorAll('[data-testid="inflight-req-pills"] .tag');
      expect(pills).toHaveLength(7); // 6 visible + "+2 more"
      expect(pills[6].textContent).toBe("+2 more");
    });

    it("renders no pill row when there is no in-flight traffic", () => {
      const { container } = render(<SparkCard spark={makeSpark("a")} temperatureUnit="celsius" />);
      expect(container.querySelector('[data-testid="inflight-req-pills"]')).toBeNull();
    });
  });
});
