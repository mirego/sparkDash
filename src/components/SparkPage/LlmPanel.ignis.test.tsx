import { expect, it, vi } from "vitest";
import { render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import { LlmPanel } from "./LlmPanel";

vi.mock("./LlmTokenTotals", () => ({ LlmTokenTotals: () => null }));
vi.mock("./LlmDailyChart", () => ({ LlmDailyChart: () => null }));
vi.mock("./LlmTrendChart", () => ({ LlmTrendChart: () => null }));

it("shows Ignis KV cache and request counters", () => {
  const llm = {
    ...makeSpark().metrics.llm[0], backend: "ignis" as const,
    kvCacheUsage: 0.25, requestsRunning: 3, requestsWaiting: 0,
  };
  const { container } = render(<LlmPanel llm={llm} sparkId="fixture" llmPort={8888} llmHost={null} lanIp="127.0.0.1" />);
  expect(container.textContent).toContain("3 run / 0 wait");
  expect(container.textContent).toContain("25.0%");
});
