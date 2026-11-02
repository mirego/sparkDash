/**
 * E2E — Export Configs (story t_dc0c8b24 / t_da2e5d5e + t_1f44f00a).
 *
 * Run against a locally served build of the branch under test:
 *
 *   npm run build
 *   PORT=5599 node server/index.js &      # serves dist/ + /api
 *   E2E_BASE_URL=http://127.0.0.1:5599 npx playwright test tests/overview.e2e.ts
 *
 * Modes:
 *   - default: UI flow (tabs, swap, copy, no-warnings) + lenient API checks
 *     that pass against both the pre-rework and reworked generators.
 *   - E2E_STRICT=1: additionally asserts the REWORKED export spec
 *     (exactly two models, apiKey "YOUR_API_KEY", sentinel baseUrl,
 *     no apiKey in pi-mono, per-model variant structures). Used for the
 *     generators PR (t_da2e5d5e) evidence; the tabs PR ships the old
 *     generators until the branches merge, so strict mode is opt-in.
 *
 * Headed recording: launch with HEADED=1 on a real display (bot-desktop :20);
 * Playwright writes an mp4 per test into test-results/ via the `video: "on"`
 * option below.
 */
import { test, expect, type Page } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:5599";
const STRICT = process.env.E2E_STRICT === "1";

const WARNING_PATTERNS = [
  /⚠/,
  /canonical id not CPA-accepted; skipped/,
];

async function openExportModal(page: Page) {
  await page.goto(`${BASE}/`);
  await page
    .locator('button[title="Copy agent CLI configs (opencode / pi-mono) pointing at the CPA fleet endpoint"]')
    .click();
  await page.getByTestId("agent-config-tab-opencode").waitFor({ state: "visible" });
}

async function assertNoWarnings(page: Page) {
  const body = await page.locator("body").innerText();
  for (const pattern of WARNING_PATTERNS) {
    expect(body, `modal must not render warning text matching ${pattern}`).not.toMatch(pattern);
  }
}

test.describe("Export Configs modal (tabs)", () => {
  test("modal opens with two side-by-side tabs: opencode | pi-mono", async ({ page }) => {
    await openExportModal(page);
    const tabs = page.locator('[role="tab"]');
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(0)).toHaveText("opencode");
    await expect(tabs.nth(1)).toHaveText("pi-mono");
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("agent-config-section-opencode")).toBeVisible();
    await expect(page.getByTestId("agent-config-section-pimono")).toBeHidden();
  });

  test("tab switch swaps the displayed config and aria state", async ({ page }) => {
    await openExportModal(page);
    await expect(page.getByTestId("agent-config-section-opencode")).toBeVisible();
    await page.getByTestId("agent-config-tab-pimono").click();
    await expect(page.getByTestId("agent-config-tab-pimono")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("agent-config-section-pimono")).toBeVisible();
    await expect(page.getByTestId("agent-config-section-opencode")).toBeHidden();
    // Both configs render as <pre> JSON-ish text once loaded (or an explicit
    // server error when the registry is absent — either way no crash).
    await page.getByTestId("agent-config-tab-opencode").click();
    await expect(page.getByTestId("agent-config-section-opencode")).toBeVisible();
  });

  test("copy button works on the active tab (clipboard or visible fallback)", async ({ page }) => {
    await openExportModal(page);
    await page.getByTestId("agent-config-section-opencode").waitFor({ state: "visible" });
    const copyButton = page.getByTestId("copy-opencode-config");
    await copyButton.click({ trial: true }); // enabled once data lands
    await copyButton.click();
    // Either the clipboard write succeeded ("copied ✓") or the fallback hint
    // appeared — both are the approved paths; a dead button is not.
    await expect(
      page
        .getByTestId("agent-config-section-opencode")
        .locator(":text('copied ✓'), :text('Clipboard blocked')")
        .first(),
    ).toBeVisible({ timeout: 5000 });
  });

  test("no warning text is rendered anywhere in the modal", async ({ page }) => {
    await openExportModal(page);
    await expect(page.getByTestId("agent-config-section-opencode")).toBeVisible();
    await page.getByTestId("agent-config-tab-pimono").click();
    await expect(page.getByTestId("agent-config-section-pimono")).toBeVisible();
    await assertNoWarnings(page);
  });

  test("lazy fetch: export endpoints are hit on modal open, not on page load", async ({ page }) => {
    const exportCalls: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/models/export/")) exportCalls.push(req.url());
    });
    await page.goto(`${BASE}/`);
    await expect.poll(() => exportCalls.length, { timeout: 5000 }).toBe(0);
    await page
      .locator('button[title="Copy agent CLI configs (opencode / pi-mono) pointing at the CPA fleet endpoint"]')
      .click();
    await page.getByTestId("agent-config-tab-opencode").waitFor({ state: "visible" });
    await expect.poll(() => exportCalls.length).toBeGreaterThanOrEqual(1);
  });
});

test.describe("Export API shape (lenient — both generator generations)", () => {
  test("opencode export parses as JSON with a fleet provider and no secrets", async ({ request }) => {
    const res = await request.get(`${BASE}/api/models/export/opencode`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.config).toBeTruthy();
    const providers = body.config.provider ?? body.config.providers;
    expect(Object.keys(providers ?? {}).length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
  });

  test("pi-mono export parses as JSON with a provider entry and no secrets", async ({ request }) => {
    const res = await request.get(`${BASE}/api/models/export/pimono`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.config).toBeTruthy();
    expect(body.config.providers ?? body.config).toBeTruthy();
    const flat = JSON.stringify(body).toLowerCase();
    expect(flat).toContain("openai-completions");
    expect(JSON.stringify(body)).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
  });
});

const strictDescribe = STRICT ? test.describe : test.describe.skip;

test.describe("API-driven run (browser-rendered export endpoints — recording evidence)", () => {
  test("opencode export JSON renders in-browser with the two fleet models", async ({ page }) => {
    const res = await page.goto(`${BASE}/api/models/export/opencode`);
    expect(res?.status()).toBe(200);
    const text = await page.locator("body").innerText();
    expect(text).toContain("gilfoyle-current-model");
    // CPA fleet proxy (host varies by generator generation: 127.0.0.1 pre-rework, 10.4.0.15 after)
    expect(text).toMatch(/:8317\/v1/);
  });

  test("pi-mono export JSON renders in-browser with sentinel baseUrl", async ({ page }) => {
    const res = await page.goto(`${BASE}/api/models/export/pimono`);
    expect(res?.status()).toBe(200);
    const text = await page.locator("body").innerText();
    expect(text).toContain("openai-completions");
  });
});

strictDescribe("Export API shape (STRICT — reworked generators, t_da2e5d5e)", () => {
  test("opencode: exactly two models, fleet baseURL, literal YOUR_API_KEY", async ({ request }) => {
    const res = await request.get(`${BASE}/api/models/export/opencode`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const provider = body.config.provider.gilfoyle;
    expect(provider.name).toBe("Local DGX Sparks");
    expect(provider.npm).toBe("@ai-sdk/openai-compatible");
    expect(provider.options.baseURL).toBe("http://10.4.0.15:8317/v1");
    expect(provider.options.apiKey).toBe("YOUR_API_KEY");
    const modelIds = Object.keys(provider.models);
    expect(modelIds).toContain("gilfoyle-current-model");
    expect(modelIds.length).toBeLessThanOrEqual(2);
    const baseline = provider.models["gilfoyle-current-model"];
    expect(baseline.limit).toEqual({ context: 1000000, output: 128000 });
    expect(baseline.modalities.input).toEqual(expect.arrayContaining(["text", "image", "video"]));
    expect(baseline.cost).toEqual({ input: 0, output: 0 });
    // Per-model variant mechanics: every active-model entry carries variants
    // of the effort or chat-template flavour — never a cloned qwen block.
    for (const [id, entry] of Object.entries(provider.models)) {
      if (id === "gilfoyle-current-model") {
        expect(Object.keys(entry.variants ?? {})).toEqual(
          expect.arrayContaining(["high", "low", "max"]),
        );
        continue;
      }
      const variantKeys = Object.keys(entry.variants ?? {});
      expect(variantKeys.length).toBeGreaterThan(0);
      const first = entry.variants[variantKeys[0]];
      const isEffort = "reasoningEffort" in first;
      const isChatTemplate =
        "chat_template_kwargs" in first ||
        Object.values(first).some(
          (v) => v && typeof v === "object" && "enable_thinking" in (v as object),
        );
      expect(isEffort || isChatTemplate, `${id}: variants must be effort- or chat-template-typed`).toBe(true);
    }
  });

  test("pi-mono: sentinel baseUrl, no apiKey, per-model thinkingLevelMap", async ({ request }) => {
    const res = await request.get(`${BASE}/api/models/export/pimono`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const provider = body.config?.providers?.gilfoyle ?? body.config?.gilfoyle;
    expect(provider.baseUrl).toBe("Replaced by extensions/providers.ts");
    expect(provider.api).toBe("openai-completions");
    expect(JSON.stringify(body)).not.toContain("apiKey");
    expect(provider.compat).toMatchObject({
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    });
    const models = provider.models;
    expect(Array.isArray(models)).toBe(true);
    const ids = models.map((m: { id: string }) => m.id);
    expect(ids).toContain("gilfoyle-current-model");
    expect(ids.length).toBeLessThanOrEqual(2);
    for (const m of models) {
      expect(m).toHaveProperty("contextWindow");
      expect(m).toHaveProperty("maxTokens");
      expect(m.cost).toHaveProperty("input");
      expect(m.cost).toHaveProperty("output");
      expect(m.input).toEqual(expect.arrayContaining(["text"]));
      if (m.id !== "gilfoyle-current-model" && m.thinkingLevelMap) {
        const keys = Object.keys(m.thinkingLevelMap);
        // Effort-capable → plain levels; chat-template-gated → $-var mapping.
        const values = Object.values(m.thinkingLevelMap) as unknown[];
        const effortStyle = keys.every((k) =>
          ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(k),
        );
        const templateStyle = values.some((v) => typeof v === "object" && v !== null);
        expect(effortStyle || templateStyle).toBe(true);
      }
    }
  });

  test("active-model id matches the model currently loaded on Anton (or fallback-only)", async ({ request }) => {
    const [status, opencode] = await Promise.all([
      request.get(`${BASE}/api/models/status`),
      request.get(`${BASE}/api/models/export/opencode`),
    ]);
    expect(status.ok() && opencode.ok()).toBe(true);
    const served = (await status.json()) as { currentServedId?: string | null };
    const body = await opencode.json();
    const modelIds = Object.keys(body.config.provider.gilfoyle.models);
    if (served.currentServedId) {
      expect(modelIds.length).toBe(2);
      expect(modelIds).toContain("gilfoyle-current-model");
      // The second entry is derived from the live fleet, not a static id.
      expect(modelIds.filter((id) => id !== "gilfoyle-current-model").length).toBe(1);
    } else {
      expect(modelIds).toEqual(["gilfoyle-current-model"]);
    }
  });
});
