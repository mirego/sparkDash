import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentConfigExportModal } from "./AgentConfigExportModal";
import { flush, render, cleanupRenders } from "../../testing/render";
import type { OpencodeExportResponse, PiMonoExportResponse } from "../../api/types";

vi.mock("../../api/client", () => ({
  fetchOpencodeExport: vi.fn(),
  fetchPiMonoExport: vi.fn(),
}));

import { fetchOpencodeExport, fetchPiMonoExport } from "../../api/client";

const fetchOpencode = vi.mocked(fetchOpencodeExport);
const fetchPiMono = vi.mocked(fetchPiMonoExport);

function opencodePayload(overrides: Partial<OpencodeExportResponse> = {}): OpencodeExportResponse {
  return {
    format: "opencode.json",
    host: "127.0.0.1",
    warnings: ["model foo/bar: canonical id not CPA-accepted; skipped"],
    config: { $schema: "https://opencode.ai/schema.json", provider: {} },
    text: '{"opencode":"config"}',
    ...overrides,
  };
}

function pimonoPayload(overrides: Partial<PiMonoExportResponse> = {}): PiMonoExportResponse {
  return {
    format: "pi-mono",
    targetPath: "~/.pi/agent/models.json",
    defaultModel: "sparkdash/foo",
    warnings: ["model baz/qux: canonical id not CPA-accepted; skipped"],
    config: {},
    text: '{"pi":"mono"}',
    ...overrides,
  };
}

async function openModal() {
  render(<AgentConfigExportModal open onClose={() => {}} />);
  await flush();
  // The modal portals into document.body, not the test container.
  return document.body;
}

afterEach(() => cleanupRenders());

describe("AgentConfigExportModal tabs", () => {
  it("renders two side-by-side tabs labeled opencode | pi-mono", async () => {
    fetchOpencode.mockResolvedValue(opencodePayload());
    fetchPiMono.mockResolvedValue(pimonoPayload());
    const container = await openModal();
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(["opencode", "pi-mono"]);
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false"]);
  });

  it("switching tabs swaps the displayed <pre> config", async () => {
    fetchOpencode.mockResolvedValue(opencodePayload());
    fetchPiMono.mockResolvedValue(pimonoPayload());
    const container = await openModal();

    expect(container.querySelector('[data-testid="agent-config-section-opencode"] pre')?.textContent).toBe(
      '{"opencode":"config"}',
    );
    expect(container.querySelector('[data-testid="agent-config-section-pimono"]')?.hasAttribute("hidden")).toBe(true);

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="agent-config-tab-pimono"]')!.click();
    });
    await flush();

    expect(container.querySelector('[data-testid="agent-config-section-pimono"] pre')?.textContent).toBe(
      '{"pi":"mono"}',
    );
    expect(container.querySelector('[data-testid="agent-config-section-opencode"]')?.hasAttribute("hidden")).toBe(true);
  });

  it("Copy copies the ACTIVE tab's config", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    fetchOpencode.mockResolvedValue(opencodePayload());
    fetchPiMono.mockResolvedValue(pimonoPayload());
    const container = await openModal();

    // active tab = opencode
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="copy-opencode-config"]')!.click();
    });
    await flush();
    expect(writeText).toHaveBeenCalledWith('{"opencode":"config"}');

    // switch to pi-mono, copy again
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="agent-config-tab-pimono"]')!.click();
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="copy-pimono-config"]')!.click();
    });
    await flush();
    expect(writeText).toHaveBeenLastCalledWith('{"pi":"mono"}');
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("renders zero warning lines under any payload", async () => {
    fetchOpencode.mockResolvedValue(opencodePayload({ warnings: ["⚠ model a: canonical id not CPA-accepted; skipped"] }));
    fetchPiMono.mockResolvedValue(pimonoPayload({ warnings: ["⚠ model b: canonical id not CPA-accepted; skipped"] }));
    const container = await openModal();
    expect(container.textContent).not.toContain("not CPA-accepted");
    expect(container.textContent).not.toContain("⚠");

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="agent-config-tab-pimono"]')!.click();
    });
    await flush();
    expect(container.textContent).not.toContain("not CPA-accepted");
    expect(container.textContent).not.toContain("⚠");
  });
});

describe("AgentConfigExportModal preserved behaviors", () => {
  it("does not fetch until open; loading spinner while fetching", async () => {
    fetchOpencode.mockReturnValue(new Promise(() => {}));
    fetchPiMono.mockReturnValue(new Promise(() => {}));
    const closed = render(<AgentConfigExportModal open={false} onClose={() => {}} />);
    await flush();
    expect(fetchOpencode).not.toHaveBeenCalled();

    const { container } = render(<AgentConfigExportModal open onClose={() => {}} />);
    await flush();
    expect(fetchOpencode).toHaveBeenCalledTimes(1);
    expect(fetchPiMono).toHaveBeenCalledTimes(1);
    expect(container.textContent + document.body.textContent).toContain("generating from live registry");
    void closed;
  });

  it("fetches once per open (no loop on re-render)", async () => {
    fetchOpencode.mockResolvedValue(opencodePayload());
    fetchPiMono.mockResolvedValue(pimonoPayload());
    await openModal();
    await flush();
    expect(fetchOpencode).toHaveBeenCalledTimes(1);
    expect(fetchPiMono).toHaveBeenCalledTimes(1);
  });

  it("409 registry-absent surfaces the server error message with no retry", async () => {
    fetchOpencode.mockRejectedValue(new Error("Model registry not initialized"));
    fetchPiMono.mockResolvedValue(pimonoPayload());
    const container = await openModal();
    await flush();
    expect(container.querySelector('[data-testid="agent-config-error-opencode"]')?.textContent).toBe(
      "Model registry not initialized",
    );
    expect(fetchOpencode).toHaveBeenCalledTimes(1);
  });

  it("never renders secret-looking payloads — only placeholder env keys are shown verbatim", async () => {
    fetchOpencode.mockResolvedValue(opencodePayload({ text: '{"apiKey":"{env:OPENCODE_API_KEY}"}' }));
    fetchPiMono.mockResolvedValue(pimonoPayload({ text: '{"apiKey":"{env:CLI_PROXY_API_KEY}"}' }));
    const container = await openModal();
    expect(container.textContent).toContain("{env:OPENCODE_API_KEY}");
    // The modal renders payload text verbatim; it must not invent or inject
    // anything — this is the secrets-discipline contract.
    expect(container.textContent).not.toContain("sk-");
  });
});
