/**
 * E2E — api-key-in-use display in the 2.0 shell (epic card t_56eaca67).
 *
 * Run against a locally served build of the branch under test:
 *
 *   npm run build
 *   PORT=5610 BIND_HOST=127.0.0.1 node server/index.js &
 *   E2E_BASE_URL=http://127.0.0.1:5610 npx playwright test tests/apikey-display.e2e.ts
 *
 * Asserts the retention requirement (d-002): the per-key api-key-in-use
 * display survives the 2.0 migration — ModelFleetPanel rows expand to an
 * "All Users" block rendering `usr.apiKeyPrefix || usr.label` with the
 * `API key: <prefix>-***` tooltip, fed by /api/models/fleet usage.users.
 *
 * Headed recording: launch with HEADED=1 on a real display (Xvnc :20);
 * Playwright writes an mp4 per test into test-results/ via video: "on"
 * (set E2E_VIDEO=1).
 */
import { test, expect, type Page } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:5610";

async function openFleetPanel(page: Page) {
  await page.goto(`${BASE}/`);
  // 2.0 shell: the fleet panel mounts on the Overview page.
  const panel = page.locator("text=Model Fleet").first();
  await panel.waitFor({ state: "visible", timeout: 15000 });
}

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

  test("expanding a fleet model row renders the api-key-in-use entry with masked tooltip", async ({ page }) => {
    // Which user entry we can assert against is data-driven: pick the first
    // (highest-usage) tracked user from the API, then verify it in the UI.
    const fleet = await (await page.request.get(`${BASE}/api/models/fleet`)).json();
    const model = fleet.models.find(
      (m: { usage?: { users?: { apiKeyPrefix: string | null; label: string }[] } }) =>
        (m.usage?.users ?? []).length > 0,
    );
    expect(model, "staging fleet has at least one model with tracked users").toBeTruthy();
    const expected = model.usage.users[0].apiKeyPrefix || model.usage.users[0].label;

    await openFleetPanel(page);
    // Expand the model row that owns the tracked user.
    const row = page.locator("button", { hasText: model.id }).first();
    await row.click();
    const apiKeyEntry = page.locator('span[title^="API key:"]', { hasText: expected });
    await expect(apiKeyEntry.first()).toBeVisible({ timeout: 10_000 });
    await expect(apiKeyEntry.first()).toHaveAttribute("title", `API key: ${expected}-***`);
    // Masked form: the display text is the prefix itself, never a full key.
    const shown = (await apiKeyEntry.first().textContent()) ?? "";
    expect(shown).toBe(expected);
  });
});
