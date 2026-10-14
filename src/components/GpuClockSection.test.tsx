import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchGpuClock, resetGpuClock, setGpuClock } from "../api/client";
import type { GpuClockStatus } from "../api/types";
import { GpuClockSection } from "./GpuClockSection";
import { flush, render } from "../testing/render";

vi.mock("../api/client", () => ({
  fetchGpuClock: vi.fn(),
  setGpuClock: vi.fn(),
  resetGpuClock: vi.fn(),
}));

const base: GpuClockStatus = {
  supported: true,
  hwMaxMHz: 3003,
  capMHz: null,
  sudo: "yes",
  service: { installed: false, clocks: null, enabled: null, active: null },
};

const buttons = (c: HTMLElement) => [...c.querySelectorAll("button")];
const byText = (c: HTMLElement, t: string) => buttons(c).find((b) => b.textContent?.includes(t)) as HTMLButtonElement;

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("GpuClockSection", () => {
  beforeEach(() => {
    vi.mocked(fetchGpuClock).mockResolvedValue(base);
    vi.mocked(setGpuClock).mockResolvedValue({ success: true, capMHz: 1800, persist: true });
    vi.mocked(resetGpuClock).mockResolvedValue({ success: true });
    vi.stubGlobal("confirm", vi.fn(() => true));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("shows the current cap and the boot service state", async () => {
    vi.mocked(fetchGpuClock).mockResolvedValue({
      ...base,
      capMHz: 1800,
      service: { installed: true, clocks: "0,1800", enabled: "enabled", active: "active" },
    });
    const { container } = render(<GpuClockSection sparkId="lab" />);
    await flush();
    const now = container.querySelector('[data-testid="gpu-clock-now"]')?.textContent ?? "";
    expect(now).toContain("Capped at 1800 MHz");
    expect(now).toContain("GPU maximum 3003 MHz");
    expect(now).toContain("boot service enabled (0,1800 MHz)");
    const input = container.querySelector("#gpu-clock-max") as HTMLInputElement;
    expect(input.value).toBe("1800");
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
  });

  it("applies a valid cap with the service and refreshes", async () => {
    const { container } = render(<GpuClockSection sparkId="lab" />);
    await flush();
    const apply = byText(container, "Apply");
    expect(apply.disabled).toBe(true);
    setInput(container.querySelector("#gpu-clock-max") as HTMLInputElement, "1800");
    act(() => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    expect(apply.disabled).toBe(false);
    await act(async () => apply.click());
    await flush();
    expect(setGpuClock).toHaveBeenCalledWith("lab", { maxMHz: 1800, persist: true });
    expect(fetchGpuClock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("kept after reboot");
  });

  it("does not send a cap outside the allowed range", async () => {
    const { container } = render(<GpuClockSection sparkId="lab" />);
    await flush();
    for (const bad of ["100", "3500", "1800.5", "abc"]) {
      setInput(container.querySelector("#gpu-clock-max") as HTMLInputElement, bad);
      expect(byText(container, "Apply").disabled).toBe(true);
    }
  });

  it("does nothing when the user cancels the service confirmation", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    const { container } = render(<GpuClockSection sparkId="lab" />);
    await flush();
    setInput(container.querySelector("#gpu-clock-max") as HTMLInputElement, "1800");
    act(() => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await act(async () => byText(container, "Apply").click());
    expect(setGpuClock).not.toHaveBeenCalled();
  });

  it("disables everything and says why when sudo needs a password", async () => {
    vi.mocked(fetchGpuClock).mockResolvedValue({ ...base, sudo: "no" });
    const { container } = render(<GpuClockSection sparkId="lab" />);
    await flush();
    expect(container.textContent).toContain("passwordless sudo");
    expect(byText(container, "Apply").disabled).toBe(true);
    expect((container.querySelector("#gpu-clock-max") as HTMLInputElement).disabled).toBe(true);
  });

  it("shows a server error from a refused change", async () => {
    vi.mocked(setGpuClock).mockRejectedValue(new Error("nvidia-smi refused the clock cap"));
    const { container } = render(<GpuClockSection sparkId="lab" />);
    await flush();
    setInput(container.querySelector("#gpu-clock-max") as HTMLInputElement, "1800");
    await act(async () => byText(container, "Apply").click());
    await flush();
    expect(container.textContent).toContain("nvidia-smi refused the clock cap");
  });

  it("removes the limit after confirmation", async () => {
    vi.mocked(fetchGpuClock).mockResolvedValue({ ...base, capMHz: 2200 });
    const { container } = render(<GpuClockSection sparkId="lab" />);
    await flush();
    await act(async () => byText(container, "Remove limit").click());
    await flush();
    expect(resetGpuClock).toHaveBeenCalledWith("lab");
  });

  it("explains a unit without nvidia-smi instead of showing controls", async () => {
    vi.mocked(fetchGpuClock).mockResolvedValue({ supported: false, reason: "nvidia-smi was not found on this unit" });
    const { container } = render(<GpuClockSection sparkId="lab" />);
    await flush();
    expect(container.textContent).toContain("nvidia-smi was not found");
    expect(buttons(container)).toHaveLength(0);
  });

  it("ignores a slow answer for the previous unit after switching units", async () => {
    let resolveOld!: (v: GpuClockStatus) => void;
    vi.mocked(fetchGpuClock).mockImplementation((id: string) =>
      id === "old"
        ? new Promise<GpuClockStatus>((r) => (resolveOld = r))
        : Promise.resolve({ ...base, capMHz: 1500, hwMaxMHz: 2418 })
    );
    const { container, root } = render(<GpuClockSection sparkId="old" />);
    await flush();
    act(() => root.render(<GpuClockSection sparkId="new" />));
    await flush();
    expect((container.querySelector("#gpu-clock-max") as HTMLInputElement).value).toBe("1500");
    await act(async () => resolveOld({ ...base, capMHz: 2200 }));
    await flush();
    expect((container.querySelector("#gpu-clock-max") as HTMLInputElement).value).toBe("1500");
    expect(container.textContent).toContain("Capped at 1500 MHz");
  });

  it("keeps the form and the success message when the refresh after a change fails", async () => {
    const { container } = render(<GpuClockSection sparkId="lab" />);
    await flush();
    setInput(container.querySelector("#gpu-clock-max") as HTMLInputElement, "1800");
    vi.mocked(fetchGpuClock).mockRejectedValue(new Error("Could not reach Lab"));
    await act(async () => byText(container, "Apply").click());
    await flush();
    expect(container.textContent).toContain("Capped at 1800 MHz until the next reboot.");
    expect(container.textContent).toContain("Could not refresh: Could not reach Lab");
    expect(container.querySelector("#gpu-clock-max")).not.toBeNull();
  });

  it("lets you remove a lock that sparkDash did not record", async () => {
    const { container } = render(<GpuClockSection sparkId="lab" />);
    await flush();
    const remove = byText(container, "Remove limit");
    expect(remove.disabled).toBe(false);
    await act(async () => remove.click());
    await flush();
    expect(resetGpuClock).toHaveBeenCalledWith("lab");
  });

  it("resets the inputs from the unit after removing the limit", async () => {
    vi.mocked(fetchGpuClock)
      .mockResolvedValueOnce({ ...base, capMHz: 2200, service: { installed: true, clocks: "0,2200", enabled: "enabled", active: "active" } })
      .mockResolvedValue(base);
    const { container } = render(<GpuClockSection sparkId="lab" />);
    await flush();
    expect((container.querySelector("#gpu-clock-max") as HTMLInputElement).value).toBe("2200");
    await act(async () => byText(container, "Remove limit").click());
    await flush();
    expect((container.querySelector("#gpu-clock-max") as HTMLInputElement).value).toBe("");
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
  });
});
