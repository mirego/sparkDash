import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelFleetPanel } from "./ModelFleetPanel";
import * as client from "../../api/client";
import { render, flush, cleanupRenders } from "../../testing/render";

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    fetchModelFleet: vi.fn(),
    fetchOpencodeExport: vi.fn(),
  };
});

const now = Date.now();

function fleetResponse(withUsers: boolean) {
  return {
    ts: now,
    source: "config/model-registry.json",
    registryLoaded: true,
    registryError: null,
    routing: { aliases: {} },
    currentServedId: "deepseek-v4-flash-0731",
    models: [
      {
        id: "deepseek-v4-flash-0731",
        aliases: [],
        capability: ["general"],
        engine: "vllm",
        recipe: "test",
        weights: "hf://test",
        served: [],
        live: [],
        health: { status: "ok" },
        usage: {
          requests: 14,
          promptTokens: 12000,
          completionTokens: 3400,
          totalTokens: 15400,
          lastSeen: now,
          users: withUsers
            ? [
                {
                  clientIp: "10.0.0.42",
                  label: "sk-ant-09",
                  apiKeyPrefix: "sk-ant-09",
                  requests: 14,
                  promptTokens: 12000,
                  completionTokens: 3400,
                  totalTokens: 15400,
                  lastSeen: now,
                },
              ]
            : [],
        },
      },
    ],
  } as any;
}

describe("ModelFleetPanel api-key-in-use display", () => {
  beforeEach(() => {
    vi.mocked(client.fetchModelFleet).mockResolvedValue(fleetResponse(true));
    vi.mocked(client.fetchOpencodeExport).mockResolvedValue({} as any);
  });

  afterEach(() => {
    cleanupRenders();
    vi.clearAllMocks();
  });

  it("renders the api-key prefix of the key in use for the currently deployed model", async () => {
    const { container } = render(<ModelFleetPanel enabled={true} />);
    await flush();
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("sk-ant-09");
    const el = [...container.querySelectorAll("span")].find((s) => s.textContent === "sk-ant-09");
    expect(el?.getAttribute("title")).toContain("API key: sk-ant-09-***");
  });

  it("omits the users block when a model has no tracked users", async () => {
    vi.mocked(client.fetchModelFleet).mockResolvedValue(fleetResponse(false));
    const { container } = render(<ModelFleetPanel enabled={true} />);
    await flush();
    await flush();
    expect(container.textContent).not.toContain("sk-ant-09");
  });
});
