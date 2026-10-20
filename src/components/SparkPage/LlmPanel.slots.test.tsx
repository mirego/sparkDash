import { describe, expect, it, vi } from "vitest";
import { render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import { LlmPanel } from "./LlmPanel";

vi.mock("./LlmTokenTotals", () => ({ LlmTokenTotals: () => null }));
vi.mock("./LlmDailyChart", () => ({ LlmDailyChart: () => null }));
vi.mock("./LlmTrendChart", () => ({ LlmTrendChart: () => null }));

describe("TensorFold slot tile", () => {
  it.each([null, 0, 8])("renders occupancy %s with known capacity", (active) => {
    const llm = { ...makeSpark().metrics.llm[0], backend: "tensorfold" as const, slotsActive: active, slotsTotal: 8 };
    const { container } = render(<LlmPanel llm={llm} sparkId="fixture" llmPort={8888} llmHost={null} lanIp="10.0.0.1" />);
    // Fork 2.0 shell: the Slots tile is a label div + value div (not sp-tile b/span markup).
    const slotGroup = [...container.querySelectorAll("div")].find((el) => el.children.length === 2 && el.children[0]?.textContent === "Slots");
    expect(slotGroup?.children[1]?.textContent).toBe(`${active ?? "?"} / 8`);
  });
});

describe("Radiance engine tiles", () => {
  it("shows the vLLM-format KV cache tile", () => {
    const llm = { ...makeSpark().metrics.llm[0], backend: "radiance" as const, kvCacheUsage: 0.25, kvCacheTokens: 1_087_768, ttftP95Seconds: 0.4 };
    const { container } = render(<LlmPanel llm={llm} sparkId="fixture" llmPort={8888} llmHost={null} lanIp="10.0.0.1" />);
    // Fork 2.0 shell: engine metrics render as label+value groups (MetricInfoTip),
    // not upstream's sp-tile markup — assert the same tiles by their labels.
    const labels = [...container.querySelectorAll(".sp-tile__label > span")].map((el) => el.textContent);
    expect(labels).toContain("KV Cache");
    expect(labels).toContain("TTFT p95");
  });
});
