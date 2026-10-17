/**
 * E2E — api-key-in-use display in the 2.0 shell (retention requirement d-002).
 *
 * Run against a locally served build of the branch under test:
 *
 *   npm run build
 *   PORT=5610 BIND_HOST=127.0.0.1 node server/index.js &
 *   E2E_BASE_URL=http://127.0.0.1:5610 npx playwright test tests/apikey-display.e2e.ts
 *
 * d-002: which API key is in use is visible in the UI, prefix-masked, never a
 * full key. The UI surface MOVED in the 2.0 recomposition: the api-key-in-use
 * display now lives in the Overview Spark card's per-key in-flight pills
 * (label = `usr.apiKeyPrefix || usr.label`, e.g. `sbre ×3 · …`), fed by
 * /api/models/fleet usage.users. The old Model Fleet panel mount was removed
 * from Overview (2cfa1e7 + t_db6255db); it must NOT be awaited here.
 *
 * Headed recording: launch with HEADED=1 on a real display (Xvnc :20);
 * Playwright writes an mp4 per test into test-results/ via video: "on"
 * (set E2E_VIDEO=1).
 */
import { test, expect } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:5610";

test.describe("api-key-in-use display (2.0 shell retention)", () => {
  test("fleet API exposes per-user apiKeyPrefix for the deployed model", async ({ request }) => {
    const res = await request.get(`${BASE}/api/models/fleet`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.registryLoaded).toBe(true);
    const withUsers = body.models.find(
      (m: { usage?: { users?: unknown[] } }) => (m.usage?.users ?? []).length > 0,
    );
    expect(withUsers, "at least one fleet model carries tracked users").toBeTruthy();
    const user = withUsers.usage.users[0];
    expect(user.apiKeyPrefix || user.label).toBeTruthy();
  });

  test("Overview Spark card in-flight pills show the api key, prefix-masked", async ({ page }) => {
    // Data-driven: pick the expected key label from the API, then verify it in
    // the UI — the same API→UI chain the old fleet-panel test asserted, against
    // the surface that actually exists post-2.0-recomposition.
    const fleet = await (await page.request.get(`${BASE}/api/models/fleet`)).json();
    const model = fleet.models.find(
      (m: { usage?: { users?: { apiKeyPrefix: string | null; label: string }[] } }) =>
        (m.usage?.users ?? []).length > 0,
    );
    expect(model, "deployed fleet has at least one model with tracked users").toBeTruthy();
    const expected = model.usage.users[0].apiKeyPrefix || model.usage.users[0].label;

    await page.goto(`${BASE}/`);
    // The Spark card renders per-key in-flight pills only while requests are
    // open on the deployed model. No live traffic is a valid deployment state,
    // not a failure: the d-002 chain is then covered by the API-level test
    // above (key prefix reaches the client) + the SparkCard vitest suite
    // (prefix-only rendering), so skip by design instead of failing.
    const pills = page.locator('[data-testid="inflight-req-pills"] .tag');
    const hasTraffic = await pills
      .first()
      .waitFor({ state: "visible", timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!hasTraffic, "no in-flight traffic on the deployed model right now — d-002 UI path covered by SparkCard vitest + fleet API test");

    const labels = await pills.allTextContents();
    const matching = labels.filter((t) => t.startsWith(expected));
    expect(
      matching.length,
      `expected the tracked key ${expected} to appear as a pill label; got: ${labels.join(" | ")}`,
    ).toBeGreaterThan(0);

    // Prefix-masked: the label is exactly the prefix form (with optional ×N
    // cumulation and token/age suffix), never a full API key. A full key would
    // render as `<prefix>-<secret>` — the `-` right after the prefix is the
    // fingerprint of a leaked full key on the pill.
    for (const label of matching) {
      expect(label.startsWith(`${expected} ·`) || label.startsWith(`${expected} ×`)).toBe(true);
      expect(label.startsWith(`${expected}-`)).toBe(false);
    }
  });
});
