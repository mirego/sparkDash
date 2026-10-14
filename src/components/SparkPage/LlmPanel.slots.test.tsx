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
