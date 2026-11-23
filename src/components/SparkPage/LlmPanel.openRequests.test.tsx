import { describe, expect, it, vi } from "vitest";
import { render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import { LlmPanel } from "./LlmPanel";

vi.mock("./LlmTokenTotals", () => ({ LlmTokenTotals: () => null }));
vi.mock("./LlmDailyChart", () => ({ LlmDailyChart: () => null }));
vi.mock("./LlmTrendChart", () => ({ LlmTrendChart: () => null }));

describe("LlmPanel open requests", () => {
  it("renders the open request box and preserves the per-key request chips", () => {
    const llm = {
      ...makeSpark().metrics.llm[0],
      backend: "vllm" as const,
      available: true,
      queueHint: "Engine queue active",
      proxyOpenRequests: {
        status: "ok" as const,
        fetchedAt: Date.now(),
        generatedAt: Date.now(),
        schemaVersion: 2,
        unattributedCount: 0,
        requests: [{ id: "request-1", label: "alice", model: "model-x", state: "streaming" as const }],
      },
      activeUsers: [{
        label: "alice",
        requests: 2,
        waiting: false,
        waitingCount: 0,
        activeCount: 2,
        inputBytes: 0,
      }],
    };
    const { container } = render(<LlmPanel llm={llm} sparkId="anton" llmPort={8888} llmHost={null} lanIp="127.0.0.1" />);

    expect(container.textContent).toContain("Open requests (1)");
    expect(container.textContent).toContain("model-x");
    expect(container.textContent).toContain("alice");
    const chips = [...container.querySelectorAll("span")].filter((chip) => chip.textContent === "alice");
    expect(chips.length).toBeGreaterThan(0);
    const activeUserChip = chips.find((chip) => chip.className.includes("rounded-full"));
    expect(activeUserChip).toBeTruthy();
    expect(activeUserChip?.getAttribute("title")).toContain("2 in-flight");
  });
});
