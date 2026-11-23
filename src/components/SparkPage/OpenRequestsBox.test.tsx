import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanupRenders, render } from "../../testing/render";
import { OpenRequestsBox } from "./OpenRequestsBox";

afterEach(() => {
  cleanupRenders();
  vi.useRealTimers();
});

const base = {
  status: "ok" as const,
  fetchedAt: Date.now(),
  generatedAt: Date.now(),
  schemaVersion: 2,
  unattributedCount: 0,
};

describe("OpenRequestsBox", () => {
  it("renders request fields and optional max/generated tokens", () => {
    const { container } = render(<OpenRequestsBox data={{
      ...base,
      requests: [{
        id: "one", label: "alice", model: "model-x", state: "queued",
        promptEstTokens: 120, maxTokens: 400, completionEstTokens: 12, ageSec: 75,
      }],
    }} />);
    expect(container.textContent).toContain("Open requests (1)");
    expect(container.textContent).toContain("alice");
    expect(container.textContent).toContain("model-x");
    expect(container.textContent).toContain("Queued");
    expect(container.textContent).toContain("Prompt ≈ 120");
    expect(container.textContent).toContain("Max 400");
    expect(container.textContent).toContain("Generated 12");
    expect(container.textContent).toContain("Age 1m 15s");
  });

  it("omits absent max and generated values and handles an empty list", () => {
    const { container, root } = render(<OpenRequestsBox data={{
      ...base,
      requests: [{ id: "one", label: "alice", state: "streaming" }],
    }} />);
    expect(container.textContent).not.toContain("Max");
    expect(container.textContent).not.toContain("Generated");
    act(() => root.render(<OpenRequestsBox data={{ ...base, requests: [] }} />));
    expect(container.textContent).toContain("No open requests");
  });

  it("shows unknown rather than zero when proxy data is missing or unavailable", () => {
    const { container, root } = render(<OpenRequestsBox />);
    expect(container.textContent).toContain("Open requests (—)");
    expect(container.textContent).toContain("Proxy unavailable — open requests unknown");
    act(() => root.render(<OpenRequestsBox data={{ ...base, status: "unavailable", requests: [] }} />));
    expect(container.textContent).toContain("Open requests (—)");
  });

  it("marks a stale snapshot and replaces its count with an em dash", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { container } = render(<OpenRequestsBox data={{
      ...base,
      fetchedAt: 1_000,
      requests: [{ id: "one", label: "alice", ageSec: 1 }],
    }} />);
    expect(container.textContent).toContain("Open requests (1)");
    act(() => vi.advanceTimersByTime(15_001));
    act(() => vi.advanceTimersByTime(5_000));
    expect(container.textContent).toContain("Stale");
    expect(container.textContent).toContain("Open requests (—)");
  });
});
