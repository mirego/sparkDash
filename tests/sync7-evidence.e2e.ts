/**
 * In-repo evidence spec for card t_87e0bf7d (upstream sync #7, merge of
 * upstream/main b0458477 into release/custom).
 *
 * Runs headed with video on against the merged app on the standard compose
 * stack and asserts the new user-visible surfaces upstream brings render in
 * the fork shell:
 *   - Settings: MQTT publishing toggle + broker URL / username / topic prefix
 *   - Settings: fleet-wide GPU clock cap row (FleetGpuClock)
 *   - Settings: language selector (i18n foundation)
 *   - Overview and Spark detail still render (fork customs intact)
 *
 * READ-ONLY: never clicks Save and never applies a clock cap. MQTT stays
 * disabled (no broker on the e2e stack); the spec only checks the form.
 *
 * Run:
 *   HEADED=1 E2E_VIDEO=1 E2E_BASE_URL=http://127.0.0.1:5601 \
 *     npx playwright test tests/sync7-evidence.e2e.ts
 */
import { test, expect, type Page } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:5599";

async function openSettings(page: Page) {
  await page.goto(`${BASE}/`);
  await page.waitForTimeout(3000); // let the WS snapshot paint
  await page.locator("button.rail-item", { hasText: "Settings" }).click();
  await expect(page.getByText("MQTT publishing", { exact: true })).toBeVisible({ timeout: 10_000 });
}

test.describe("sync #7 evidence", () => {
  test("Overview renders the fleet with fork customs", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await page.waitForTimeout(4000);
    const text = await page.locator("body").innerText();
    console.log("=== OVERVIEW TEXT (trimmed) ===\n" + text.slice(0, 3000));
    expect(text.toLowerCase()).toContain("fleet");
    await expect(page.locator("a.ov-sc__link").first()).toBeVisible();
    await page.screenshot({ path: "test-results/sync7-overview.png", fullPage: true });
  });

  test("Spark detail renders LLM panel and hardware column", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await page.waitForTimeout(3000);
    await page.locator("a.ov-sc__link").first().click();
    await page.waitForTimeout(4000);
    console.log("URL after click:", page.url());
    const text = await page.locator("body").innerText();
    console.log("=== SPARK DETAIL TEXT (trimmed) ===\n" + text.slice(0, 3000));
    expect(/LLM server/i.test(text)).toBe(true);
    expect(/history/i.test(text)).toBe(true);
    await page.screenshot({ path: "test-results/sync7-sparkdetail.png", fullPage: true });
  });

  test("Settings shows the MQTT publishing surface", async ({ page }) => {
    await openSettings(page);
    const mqtt = page.getByText("MQTT publishing", { exact: true });
    await mqtt.scrollIntoViewIfNeeded();
    await expect(page.getByText("MQTT broker URL", { exact: true })).toBeVisible();
    await expect(page.locator("#settings-mqtt-url")).toBeVisible();
    await expect(page.locator("#settings-mqtt-username")).toBeVisible();
    await expect(page.locator("#settings-mqtt-prefix")).toBeVisible();
    console.log("mqtt prefix value:", await page.locator("#settings-mqtt-prefix").inputValue());
    await page.waitForTimeout(1500);
    await page.screenshot({ path: "test-results/sync7-settings-mqtt.png" });
  });

  test("Settings shows the fleet GPU clock cap and language selector", async ({ page }) => {
    await openSettings(page);
    const cap = page.getByText("GPU clock cap", { exact: true });
    await cap.scrollIntoViewIfNeeded();
    await expect(cap).toBeVisible();
    await page.waitForTimeout(3000); // fleet clock state loads per Spark
    const row = page.locator(".set-row, [class*='set-']").filter({ has: cap }).first();
    const rowText = (await row.innerText().catch(() => "")) || "";
    console.log("=== GPU CLOCK CAP ROW ===\n" + rowText.slice(0, 1500));
    expect(/Full capacity|MHz|skipped|offline|cap/i.test(rowText)).toBe(true);
    await page.screenshot({ path: "test-results/sync7-settings-gpuclock.png" });

    const body = await page.locator("body").innerText();
    expect(/language/i.test(body)).toBe(true);
  });
});
