/**
 * E2E — fleet LLM request lifecycle in Overview "Recent activity" (flat timeline, t_3c1594c0) and the full Activity page
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

  test("root Overview Recent activity: one flat newest-first timeline (open, completed, system rows)", async ({ page }) => {
    // Two requests already open BEFORE the page loads (initial hydration).
    await ctl(page, "start", { id: SECRET_IDS[0], user: "hermes", model: "gilfoyle-current-model", promptEstTokens: 5200, maxTokens: 4096, ageSec: 40 });
    await ctl(page, "start", { id: SECRET_IDS[1], user: "sbre", model: "model-b@b:son-of-anton", promptEstTokens: 900, ageSec: 5 });
    await ctl(page, "stream", { id: SECRET_IDS[1], completionEstTokens: 120 });
    await page.waitForTimeout(2500); // one server reconcile tick

    await page.goto(`${BASE}/`);
    const feed = page.locator("section.activity-feed");
    const list = feed.locator("ul");
    const openRows = feed.locator(".af-req-row:not([data-status=completed])");
    const doneRows = feed.locator(".af-req-row[data-status=completed]");
    const systemRow = list.locator("> li", { hasText: "Anton came online" });
    /** Index of a row among ALL rows of the single flat list. */
    const indexOf = async (text: string) => (await list.locator("> li").allTextContents()).findIndex((t) => t.includes(text));

    await expect(openRows).toHaveCount(2, { timeout: 15_000 });
    await expect(feed).toContainText("Legacy proxy: terminal outcomes reported as Unknown");

    // Flat DOM: no pinned section, one list, every row a direct child, nothing nested.
    await expect(feed.locator(".ac-requests")).toHaveCount(0);
    await expect(list).toHaveCount(1);
    await expect(feed.locator("li li, li ul")).toHaveCount(0);
    expect(await feed.locator("li").count()).toBe(await list.locator("> li").count());

    // Two-line rows: line 1 = Spark + age; line 2 = green key chip first … status chip last.
    const hermes = openRows.filter({ hasText: "hermes" });
    await expect(hermes.locator(".af-req-line1")).toContainText("Anton");
    await expect(hermes.locator(".af-req-line2 > :first-child")).toHaveText("hermes");
    await expect(hermes.locator(".af-req-line2 > :first-child")).toHaveClass(/tag--good/);
    await expect(hermes.locator(".af-req-line2 > :last-child")).toHaveText("Pending");
    await expect(hermes).toContainText("prompt ~5,200");
    await expect(hermes).toContainText("out — / max 4,096");
    const sbre = openRows.filter({ hasText: "sbre" });
    await expect(sbre.locator(".af-req-line1")).toContainText("Son of Anton");
    await expect(sbre.locator(".af-req-line2 > :last-child")).toHaveText("Active");
    await expect(sbre).toContainText("out 120 / max —");

    // Open rows (seen now) sit above the 10-minute-old system event in the SAME list.
    await expect(systemRow).toBeVisible();
    expect(await indexOf("hermes")).toBeLessThan(await indexOf("Anton came online"));
    await beat(page);

    // A new request starts while the view is open.
    await ctl(page, "start", { id: SECRET_IDS[2], user: "olivier", model: "gilfoyle-current-model", promptEstTokens: 300, maxTokens: 512 });
    await expect(openRows).toHaveCount(3, { timeout: 10_000 });
    await beat(page);

    // Pending → Active.
    await ctl(page, "stream", { id: SECRET_IDS[0], completionEstTokens: 64 });
    await expect(hermes.locator(".af-req-line2 > :last-child")).toHaveText("Active", { timeout: 10_000 });
    await beat(page);

    // Terminal: hermes finishes → becomes a Completed row in the same flat list.
    await ctl(page, "finish", { id: SECRET_IDS[0] });
    await expect(openRows).toHaveCount(2, { timeout: 10_000 });
    const done = doneRows.filter({ hasText: "hermes" });
    await expect(done).toHaveCount(1, { timeout: 15_000 });
    await expect(done.locator(".af-req-line2 > :first-child")).toHaveText("hermes");
    await expect(done.locator(".af-req-line2 > :last-child")).toHaveText("Completed");
    await expect(done).toContainText("Outcome: Unknown (legacy proxy)");
    await expect(done.locator(".af-req-line1")).toContainText("Outcome: Unknown (legacy proxy)");
    // Normal card width: every request row is two visual lines; both chips sit on line 2.
    const lineCounts = await feed.locator(".af-req-row").evaluateAll((rows) => rows.map((row) =>
      [".af-req-line1", ".af-req-line2"].map((sel) => new Set([...row.querySelector(sel)!.children].map((c) => {
        const b = c.getBoundingClientRect(); return Math.round(b.top + b.height / 2);
      })).size)));
    for (const [l1, l2] of lineCounts) { expect(l1).toBe(1); expect(l2).toBe(1); }
    // Newest first: completed row above the older system event; still-open rows (seen again on
    // later polls) move above it — interleaved, not pinned.
    expect(await indexOf("Outcome: Unknown")).toBeLessThan(await indexOf("Anton came online"));
    await expect.poll(async () => (await indexOf("sbre")) < (await indexOf("Outcome: Unknown")), { timeout: 15_000 }).toBe(true);
    await beat(page);

    // Proxy outage: explicit unavailable state, rows marked Stale, no synthetic completion.
    await ctl(page, "mode", { mode: "down" });
    await expect(feed.locator(".af-req-state")).toHaveText("Proxy unavailable — open requests unknown", { timeout: 10_000 });
    await expect(openRows.first()).toContainText("Stale");
    await expect(doneRows).toHaveCount(1);
    await beat(page, 2000);

    // Recovery: state line clears, open rows return fresh, no duplicate completed rows.
    await ctl(page, "mode", { mode: "legacy" });
    await expect(feed.locator(".af-req-state")).toHaveCount(0, { timeout: 10_000 });
    await expect(openRows).toHaveCount(2);
    await expect(doneRows).toHaveCount(1);
    await expectNoLeaks(page);
    await beat(page);

    // Spark navigation from a request row still opens that Spark.
    await openRows.filter({ hasText: "sbre" }).locator(".af-req-line1 a").click();
    await expect(page).toHaveURL(/son-of-anton/);
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
