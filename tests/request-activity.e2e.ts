/**
 * E2E — fleet LLM request lifecycle in Overview "Recent activity" and the full Activity page
 * (t_98955a1d).
 *
 * Runs against an ISOLATED stack: a branch server with temp config whose auth-proxy source is
 * the fake `/inflight` fixture (tests/fixtures/fake-inflight.mjs, legacy shape by default).
 * Never point this at production (:5555) or the live proxy (:8317).
 *
 *   npm run build
 *   E2E_DIR=$TMPDIR/t989-e2e bash tests/fixtures/request-activity-stack.sh &   # fake proxy :18317 + server :5611
 *   E2E_BASE_URL=http://127.0.0.1:5611 FAKE_INFLIGHT_URL=http://127.0.0.1:18317 \
 *     HEADED=1 E2E_VIDEO=1 DISPLAY=:20 npx playwright test tests/request-activity.e2e.ts
 *
 * Covers: initial hydration of open requests (pinned above ordinary rows), a new start while the
 * view is open, Pending → Active, terminal demotion into history with outcome Unknown (legacy
 * proxy), proxy outage → explicit "Proxy unavailable" (no false zero, no synthetic completion),
 * recovery, preserved ordinary events, the same records on the Activity page with its category
 * filter, and that no request id / path leaks into the page.
 */
import { test, expect, type Page } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:5611";
const FAKE = process.env.FAKE_INFLIGHT_URL || "http://127.0.0.1:18317";
const SECRET_IDS = ["req-secret-a1", "req-secret-b2", "req-secret-c3"];

async function ctl(page: Page, op: string, body: Record<string, unknown> = {}) {
  const res = await page.request.post(`${FAKE}/_ctl/${op}`, { data: body });
  expect(res.ok()).toBe(true);
}

/** Slow the run down a little so the headed recording is watchable. */
const beat = (page: Page, ms = 1200) => page.waitForTimeout(ms);

async function expectNoLeaks(page: Page) {
  const html = await page.content();
  for (const id of SECRET_IDS) expect(html).not.toContain(id);
  expect(html).not.toContain("/v1/chat/completions");
}

test.describe.configure({ mode: "serial" });

test.describe("fleet request lifecycle in Activity", () => {
  test.beforeAll(async ({ request }) => {
    await request.post(`${FAKE}/_ctl/reset`);
  });

  test("root Overview Recent activity: hydrate, start, stream, finish, outage, recovery", async ({ page }) => {
    // Two requests already open BEFORE the page loads (initial hydration).
    await ctl(page, "start", { id: SECRET_IDS[0], user: "hermes", model: "gilfoyle-current-model", promptEstTokens: 5200, maxTokens: 4096, ageSec: 40 });
    await ctl(page, "start", { id: SECRET_IDS[1], user: "sbre", model: "model-b@b:son-of-anton", promptEstTokens: 900, ageSec: 5 });
    await ctl(page, "stream", { id: SECRET_IDS[1], completionEstTokens: 120 });
    await page.waitForTimeout(2500); // one server reconcile tick

    await page.goto(`${BASE}/`);
    const feed = page.locator("section.activity-feed");
    const pinned = feed.locator(".ac-requests");
    await expect(pinned).toBeVisible({ timeout: 15_000 });
    await expect(pinned.locator(".ac-request-row")).toHaveCount(2, { timeout: 15_000 });
    await expect(pinned.locator(".ac-requests__count")).toHaveText("2");
    await expect(pinned).toContainText("Legacy proxy: terminal outcomes reported as Unknown");

    // Newest start first: sbre (5 s old) above hermes (40 s old).
    const rows = pinned.locator(".ac-request-row");
    await expect(rows.nth(0)).toContainText("sbre");
    await expect(rows.nth(0)).toContainText("Active");
    await expect(rows.nth(0)).toContainText("Son of Anton");
    await expect(rows.nth(0)).toContainText("out 120");
    await expect(rows.nth(1)).toContainText("hermes");
    await expect(rows.nth(1)).toContainText("Pending");
    await expect(rows.nth(1)).toContainText("Anton");
    await expect(rows.nth(1)).toContainText("prompt ~5,200");
    await expect(rows.nth(1)).toContainText("out — / max 4,096");

    // Pinned group sits above the ordinary activity rows; the seeded system event is still there.
    await expect(feed).toContainText("Anton came online");
    const pinnedBox = await pinned.boundingBox();
    const ordinary = feed.locator("ul.divide-y li", { hasText: "Anton came online" });
    const ordinaryBox = await ordinary.boundingBox();
    expect(pinnedBox!.y).toBeLessThan(ordinaryBox!.y);
    await beat(page);

    // A new request starts while the view is open.
    await ctl(page, "start", { id: SECRET_IDS[2], user: "olivier", model: "gilfoyle-current-model", promptEstTokens: 300, maxTokens: 512 });
    await expect(rows).toHaveCount(3, { timeout: 10_000 });
    await expect(rows.nth(0)).toContainText("olivier");
    await beat(page);

    // Pending → Active.
    await ctl(page, "stream", { id: SECRET_IDS[0], completionEstTokens: 64 });
    await expect(pinned.locator(".ac-request-row", { hasText: "hermes" })).toContainText("Active", { timeout: 10_000 });
    await beat(page);

    // Terminal: hermes finishes → leaves the pinned group, enters history with outcome Unknown.
    await ctl(page, "finish", { id: SECRET_IDS[0] });
    await expect(rows).toHaveCount(2, { timeout: 10_000 });
    const endedRow = feed.locator("ul.divide-y li", { hasText: "Outcome: Unknown" }).first();
    await expect(endedRow).toBeVisible({ timeout: 10_000 });
    await expect(endedRow).toContainText("Completed");
    await expect(endedRow).toContainText("hermes");
    // Newest first in history: the ended request is above the older system event.
    const endedBox = await endedRow.boundingBox();
    const ordinaryBox2 = await ordinary.boundingBox();
    expect(endedBox!.y).toBeLessThan(ordinaryBox2!.y);
    await beat(page);

    // Proxy outage: no false zero, no synthetic completion; rows marked stale.
    await ctl(page, "mode", { mode: "down" });
    await expect(pinned).toContainText("Proxy unavailable — open requests unknown", { timeout: 10_000 });
    await expect(pinned.locator(".ac-requests__count")).toHaveText("—");
    await expect(pinned.locator(".ac-request-row").first()).toContainText("Stale");
    await expect(feed.locator("ul.divide-y li", { hasText: "Outcome: Unknown" })).toHaveCount(1);
    await beat(page, 2000);

    // Recovery: rows still open come back fresh without duplicate history rows.
    await ctl(page, "mode", { mode: "legacy" });
    await expect(pinned.locator(".ac-requests__count")).toHaveText("2", { timeout: 10_000 });
    await expect(pinned).not.toContainText("Proxy unavailable");
    await expect(feed.locator("ul.divide-y li", { hasText: "Outcome: Unknown" })).toHaveCount(1);
    await expectNoLeaks(page);
    await beat(page);
  });

  test("full Activity page: same records, pinned above timeline, category filter", async ({ page }) => {
    await page.goto(`${BASE}/activity`);
    const pinned = page.locator(".ac-requests-panel .ac-requests");
    await expect(pinned).toBeVisible({ timeout: 15_000 });
    await expect(pinned.locator(".ac-request-row")).toHaveCount(2, { timeout: 10_000 });
    const timeline = page.locator(".ac-timeline");
    await expect(timeline).toContainText("Outcome: Unknown");
    await expect(timeline).toContainText("Anton came online");
    const pBox = await pinned.boundingBox();
    const tBox = await timeline.boundingBox();
    expect(pBox!.y).toBeLessThan(tBox!.y);
    await beat(page);

    // Finish another request while on this page → demoted into the timeline.
    await ctl(page, "finish", { id: SECRET_IDS[1] });
    await expect(pinned.locator(".ac-request-row")).toHaveCount(1, { timeout: 10_000 });
    await expect(timeline.locator(".ac-row", { hasText: "Outcome: Unknown" })).toHaveCount(2, { timeout: 20_000 });
    await beat(page);

    // Category filter: "LLM requests" keeps request rows, hides the system event.
    await page.locator(".ac-filters select").first().selectOption("requests");
    await expect(timeline).not.toContainText("Anton came online");
    await expect(timeline.locator(".ac-row", { hasText: "Outcome: Unknown" })).toHaveCount(2);
    await expect(pinned).toBeVisible();
    await beat(page);
    // Status category: request rows (and the pinned panel) leave, system history stays.
    await page.locator(".ac-filters select").first().selectOption("status");
    await expect(timeline).toContainText("Anton came online");
    await expect(page.locator(".ac-requests-panel")).toHaveCount(0);
    await beat(page);
    await page.locator(".ac-filters select").first().selectOption("all");

    // Clear history: terminal rows go, the still-open request stays pinned.
    page.once("dialog", (d) => void d.accept());
    const res = await page.request.delete(`${BASE}/api/events`);
    expect(res.ok()).toBe(true);
    await page.reload();
    await expect(pinned.locator(".ac-request-row")).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator(".ac-timeline .ac-row", { hasText: "Outcome: Unknown" })).toHaveCount(0);
    await expectNoLeaks(page);
    await beat(page, 1500);
  });
});
