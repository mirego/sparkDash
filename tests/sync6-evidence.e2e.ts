/**
 * In-repo evidence spec for card t_6bd91b95 (upstream sync #6, merge of
 * upstream/main 2c736a7261 into release/custom).
 *
 * Runs headed with video on against the merged app on the standard compose
 * stack (:5599) and asserts the metrics upstream 2c736a7261 brings are
 * actually rendered:
 *   - per-stream decode tok/s (Spark card + LLM panel)
 *   - busy-GPU process naming on the Spark card
 *   - fleet KPI row on Overview
 *   - History panels in the hardware column on Spark detail
 *
 * Run:
 *   HEADED=1 E2E_VIDEO=1 E2E_BASE_URL=http://127.0.0.1:5599 \
 *     npx playwright test tests/sync6-evidence.e2e.ts
 */
import { test, expect } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:5599";

test.describe("sync #6 evidence", () => {
  test("Overview renders fleet KPIs, busy-GPU naming and per-stream tok/s", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await page.waitForTimeout(4000); // let the WS snapshot paint

    const text = await page.locator("body").innerText();
    console.log("=== OVERVIEW TEXT (trimmed) ===\n" + text.slice(0, 5000));

    expect(text.toLowerCase()).toContain("fleet");
    expect(/in use by/i.test(text) || /tensorfold-native|tf-dsv41/i.test(text)).toBe(true);
    expect(/per stream/i.test(text)).toBe(true);

    await page.screenshot({ path: "test-results/sync6-overview.png", fullPage: true });
  });

  test("Spark detail renders LLM panel with per-stream tok/s and hardware column", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await page.waitForTimeout(3000);

    // Stretched link on the card name navigates to the Spark detail page.
    await page.locator("a.ov-sc__link").first().click();
    await page.waitForTimeout(4000);
    console.log("URL after click:", page.url());

    const text = await page.locator("body").innerText();
    console.log("=== SPARK DETAIL TEXT (trimmed) ===\n" + text.slice(0, 5000));

    expect(/per stream/i.test(text)).toBe(true);
    expect(/history/i.test(text)).toBe(true);

    await page.screenshot({ path: "test-results/sync6-sparkdetail.png", fullPage: true });
  });
});
