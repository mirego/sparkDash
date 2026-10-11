import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetStore, getMetricHistorySamples } from "./metricsStore";
import { useSnapshot } from "./useSnapshot";
import { BENCH_PREFIX, ENERGY_ID, OVERVIEW_ID } from "../constants";
import { makeSpark } from "../testing/fixtures";
import { onAuthRequired, setToken } from "../api/authToken";
import { flush, render } from "../testing/render";

class MockSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: MockSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    MockSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(data: unknown) {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

function Probe() {
  const snapshot = useSnapshot();
  return (
    <pre data-testid="probe">
      {JSON.stringify({
        connected: snapshot.connected,
        error: snapshot.snapshotError,
        last: snapshot.lastValidSnapshotAt,
        count: snapshot.sparks.length,
        activeId: snapshot.activeId,
      })}
    </pre>
  );
}

function readProbe() {
  return JSON.parse(document.querySelector("[data-testid=probe]")!.textContent || "{}");
}

describe("useSnapshot connection lifecycle", () => {
  beforeEach(() => {
    _resetStore();
    MockSocket.instances = [];
    vi.stubGlobal("WebSocket", MockSocket);
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { protocol: "http:", host: "localhost:5555" },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.removeItem("sparkdashToken");
  });

  it("stays disconnected until a valid snapshot, then recovers after disconnect and malformed data", async () => {
    render(<Probe />);
    const socket = MockSocket.instances[0];
    act(() => socket.open());
    await flush();
    expect(readProbe().connected).toBe(false);

    act(() => socket.emit({
      type: "snapshot",
      generatedAt: 50_000,
      refreshInterval: 2000,
      sparks: [makeSpark("alpha")],
    }));
    await flush();
    expect(readProbe()).toMatchObject({ connected: true, count: 1, error: null, last: 50_000 });
    expect(getMetricHistorySamples("alpha", "gpu.usage")[0]).toEqual({ at: 50_000, value: 42 });

    act(() => socket.close());
    await flush();
    expect(readProbe().connected).toBe(false);
    expect(readProbe().count).toBe(1);

    act(() => vi.advanceTimersByTime(2000));
    const next = MockSocket.instances[1];
    act(() => next.open());
    act(() => next.emit("not-json"));
    await flush();
    expect(readProbe().error).toContain("malformed");
    expect(readProbe().connected).toBe(false);

    act(() => next.emit({ type: "snapshot", generatedAt: 51_000, refreshInterval: 2000, sparks: [makeSpark("alpha")] }));
    await flush();
    expect(readProbe()).toMatchObject({ connected: true, error: null });
    expect(readProbe().last).toBeGreaterThanOrEqual(50_000);
  });

  it("reconnects with the new ?token= as soon as a token is saved", async () => {
    render(<Probe />);
    const first = MockSocket.instances[0];
    expect(first.url).toBe("ws://localhost:5555/ws");

    act(() => setToken("a b/c"));
    expect(MockSocket.instances).toHaveLength(2);
    expect(MockSocket.instances[1].url).toBe("ws://localhost:5555/ws?token=a%20b%2Fc");
    // The replaced socket must not schedule a second reconnect of its own.
    act(() => first.close());
    act(() => vi.advanceTimersByTime(5000));
    expect(MockSocket.instances).toHaveLength(2);
  });

  it("asks for a token once when the server refuses the socket for it", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ tokenRequired: true, authenticated: false }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const reasons: string[] = [];
    const off = onAuthRequired((r) => reasons.push(r));
    try {
      render(<Probe />);
      act(() => MockSocket.instances[0].close());
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith("/api/auth/status", { headers: {} });
      expect(reasons).toEqual(["rejected"]);

      // Retries with the same (missing) token do not re-ask every 2 seconds.
      act(() => vi.advanceTimersByTime(2000));
      act(() => MockSocket.instances[1].close());
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it("does not prompt when the socket drops for another reason", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ tokenRequired: false, authenticated: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const reasons: string[] = [];
    const off = onAuthRequired((r) => reasons.push(r));
    try {
      render(<Probe />);
      act(() => MockSocket.instances[0].close());
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(reasons).toEqual([]);
    } finally {
      off();
    }
  });
});

describe("useSnapshot activeId preservation", () => {
  beforeEach(() => {
    _resetStore();
    MockSocket.instances = [];
    vi.stubGlobal("WebSocket", MockSocket);
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { protocol: "http:", host: "localhost:5555" },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.removeItem("sparkdashToken");
  });

  function renderOn(path: string) {
    const origPathname = Object.getOwnPropertyDescriptor(window.location, "pathname");
    Object.defineProperty(window.location, "pathname", { configurable: true, value: path });
    try {
      render(<Probe />);
    } finally {
      if (origPathname) Object.defineProperty(window.location, "pathname", origPathname);
    }
  }

  it("keeps a reserved page tab (energy) selected across WS snapshots", async () => {
    renderOn("/energy");
    const socket = MockSocket.instances[0];
    act(() => socket.open());
    await flush();
    expect(readProbe().activeId).toBe(ENERGY_ID);

    for (const generatedAt of [50_000, 51_000, 52_000]) {
      act(() => socket.emit({
        type: "snapshot",
        generatedAt,
        refreshInterval: 1000,
        sparks: [makeSpark("alpha")],
      }));
      await flush();
      expect(readProbe().activeId).toBe(ENERGY_ID);
    }
  });

  it("keeps a bench page tab selected across WS snapshots", async () => {
    renderOn("/bench/decode");
    const socket = MockSocket.instances[0];
    act(() => socket.open());
    await flush();
    expect(readProbe().activeId).toBe(BENCH_PREFIX + "decode");

    act(() => socket.emit({
      type: "snapshot",
      generatedAt: 50_000,
      refreshInterval: 1000,
      sparks: [makeSpark("alpha")],
    }));
    await flush();
    expect(readProbe().activeId).toBe(BENCH_PREFIX + "decode");
  });

  it("still falls back to overview when the active spark leaves the fleet", async () => {
    renderOn("/spark/gone");
    const socket = MockSocket.instances[0];
    act(() => socket.open());
    await flush();
    // initialActiveId reads the URL; the spark is not in any snapshot yet.
    act(() => socket.emit({
      type: "snapshot",
      generatedAt: 50_000,
      refreshInterval: 1000,
      sparks: [makeSpark("alpha")],
    }));
    await flush();
    expect(readProbe().activeId).toBe(OVERVIEW_ID);
  });

  it("keeps a spark tab selected while it is still in the fleet", async () => {
    renderOn("/spark/alpha");
    const socket = MockSocket.instances[0];
    act(() => socket.open());
    await flush();
    act(() => socket.emit({
      type: "snapshot",
      generatedAt: 50_000,
      refreshInterval: 1000,
      sparks: [makeSpark("alpha")],
    }));
    await flush();
    act(() => socket.emit({
      type: "snapshot",
      generatedAt: 51_000,
      refreshInterval: 1000,
      sparks: [makeSpark("alpha"), makeSpark("beta")],
    }));
    await flush();
    expect(readProbe().activeId).toBe("alpha");
  });
});
