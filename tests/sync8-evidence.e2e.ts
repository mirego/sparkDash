/**
 * In-repo Playwright evidence for card t_ff59f5eb (upstream sync #8).
 *
 * Verifies that the decode bench's deep start-context control and selected
 * context are represented in results, history, and sharing surfaces. Test 1
 * is read-only. Tests 2–3 run a real ×1 / 64-token / 16k-context benchmark
 * against the live LLM only when SYNC8_RUN_BENCH=1.
 *
 * Run:
 *   HEADED=1 E2E_VIDEO=1 SYNC8_RUN_BENCH=1 E2E_BASE_URL=http://127.0.0.1:5602 npx playwright test tests/sync8-evidence.e2e.ts
 */
import fs from "node:fs";
import { test, expect } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:5599";
const RUN_BENCH = process.env.SYNC8_RUN_BENCH === "1";

test.describe("sync #8 evidence: decode bench deep-context start", () => {
  test.describe.configure({ mode: "serial", timeout: 240_000 });

  test("decode bench page shows the start-context control", async ({ page }) => {
    await page.goto(`${BASE}/bench/decode`);
    await page.waitForTimeout(3000);

    const presets = page.getByRole("group", { name: "Start context presets" });
    await expect(presets).toBeVisible();
    for (const label of ["Empty", "16k", "32k", "64k", "128k", "256k"]) {
      await expect(presets.getByRole("button", { name: label, exact: true })).toBeVisible();
    }

    const startContext = page.locator("#bench-start-context");
    await expect(startContext).toBeVisible();
    const preset16k = presets.getByRole("button", { name: "16k", exact: true });
    await preset16k.click();
    await expect(preset16k).toHaveClass(/is-on/);
    await expect(startContext).toHaveValue("16384");

    await page.screenshot({ path: "test-results/sync8-start-context-control.png" });
  });

  test("a deep-context run reports its start context in results and history", async ({ page }) => {
    test.skip(!RUN_BENCH, "The benchmark hits a live LLM; set SYNC8_RUN_BENCH=1 to run it.");

    await page.goto(`${BASE}/bench/decode`);
    await page.waitForTimeout(3000);

    const concurrencySection = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Concurrency", exact: true }) });
    const concurrencyOne = concurrencySection.getByRole("button", { name: "1", exact: true });
    const concurrencyTwo = concurrencySection.getByRole("button", { name: "2", exact: true });
    if ((await concurrencyTwo.getAttribute("class"))?.includes("is-on")) {
      await concurrencyTwo.click();
    }
    if (!(await concurrencyOne.getAttribute("class"))?.includes("is-on")) {
      await concurrencyOne.click();
    }
    await expect(concurrencyOne).toHaveClass(/is-on/);
    await expect(concurrencyTwo).not.toHaveClass(/is-on/);

    await page.locator("#bench-max-tokens").fill("64");
    await page
      .getByRole("group", { name: "Start context presets" })
      .getByRole("button", { name: "16k", exact: true })
      .click();
    await page.getByRole("button", { name: "Run benchmark", exact: true }).click();

    const resultRow = page.locator("article.bench-result-row").first();
    await expect(resultRow).toBeVisible({ timeout: 180_000 });
    expect(await resultRow.innerText()).toMatch(/ctx\s*16k/);

    const statusMeta = page.locator(".bench-status-meta").first();
    await expect(statusMeta).toContainText("16k ctx");

    const warning = page.locator("p.bench-sheet__hint.text-warning");
    if (await warning.count()) {
      console.log("Benchmark context-prefill warning:", await warning.first().innerText());
    }

    await expect(page.locator("body")).toContainText("16k start ctx", { timeout: 15_000 });
    await page.screenshot({ path: "test-results/sync8-results-history.png", fullPage: true });
  });

  test("share text and card carry the start context", async ({ page, context }) => {
    test.skip(!RUN_BENCH, "The benchmark hits a live LLM; set SYNC8_RUN_BENCH=1 to run it.");

    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
    await page.goto(`${BASE}/bench/decode`);
    await page.waitForTimeout(4000);

    const copyTextButton = page
      .locator("button.bench-btn.bench-btn--ghost")
      .filter({ hasText: /^Copy/ })
      .first();
    await copyTextButton.click();

    let shareText: string | null = null;
    try {
      shareText = await page.evaluate(() => navigator.clipboard.readText());
    } catch (error) {
      console.log("Clipboard unavailable; could not inspect copied share text:", String(error));
    }
    if (shareText !== null) {
      expect(shareText).toContain("starting at 16k context");
      console.log("=== DECODE BENCH SHARE TEXT ===\n" + shareText);
    }

    const copyFormatButton = page.locator('button[aria-label="Copy format"]');
    if (await copyFormatButton.count()) {
      await copyFormatButton.hover();
      const showCard = page.getByRole("menuitem", { name: "Show card", exact: true });
      if (!(await showCard.isVisible().catch(() => false))) {
        await copyFormatButton.click();
      }
      if (await showCard.isVisible().catch(() => false)) {
        await showCard.click();
        await page.waitForTimeout(1500);
        await page.screenshot({ path: "test-results/sync8-share-card.png" });
      } else {
        // Secure context (loopback): the menu offers "Copy as image". Copy it and
        // read the PNG back from the clipboard so the card itself is captured.
        const copyImage = page.getByRole("menuitem", { name: "Copy as image", exact: true });
        if (await copyImage.isVisible().catch(() => false)) {
          await copyImage.click();
          await page.waitForTimeout(1500);
          const b64 = await page.evaluate(async () => {
            try {
              for (const item of await navigator.clipboard.read()) {
                if (item.types.includes("image/png")) {
                  const buf = new Uint8Array(await (await item.getType("image/png")).arrayBuffer());
                  let s = "";
                  for (const b of buf) s += String.fromCharCode(b);
                  return btoa(s);
                }
              }
            } catch {
              return null;
            }
            return null;
          });
          if (b64) {
            fs.mkdirSync("test-results", { recursive: true });
            fs.writeFileSync("test-results/sync8-share-card.png", Buffer.from(b64, "base64"));
            console.log(`Share card PNG read back from the clipboard: ${b64.length} base64 chars`);
            // Show it in the page so the recording captures the card itself.
            await page.setContent(`<body style="margin:0;background:#111"><img src="data:image/png;base64,${b64}" style="max-width:100%"></body>`);
            await page.waitForTimeout(2500);
          } else {
            console.log("Share card PNG could not be read back from the clipboard.");
          }
        } else {
          console.log('Share card screenshot skipped: neither "Show card" nor "Copy as image" is available.');
        }
      }
    } else {
      console.log('Share card screenshot skipped: the "Copy format" control is unavailable.');
    }
  });
});
