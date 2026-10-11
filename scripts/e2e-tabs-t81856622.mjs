/**
 * t_81856622 headed e2e: sidebar tab selection persists across WS snapshots.
 * Headed Chromium on Xvnc :20 against local prod build (:5591);
 * ffmpeg x11grab records the whole session (driven separately).
 *
 * Asserts: click >=3 sidebar tabs (Token totals, Fleet energy, Activity),
 * each stays selected >10s across WS snapshot cycles, then a full reload
 * retains the tab.
 */
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:5591";
const results = [];

function log(msg) { console.log(`[e2e] ${new Date().toISOString()} ${msg}`); }

async function expectSelected(page, label, urlPart, activeSel) {
  const url = page.url();
  let ok = url.includes(urlPart);
  if (ok && activeSel) {
    // Poll briefly: React re-renders after the click.
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.getAttribute("aria-current") === "page",
      activeSel,
      { timeout: 5000 }
    ).catch(() => {});
    const current = await page.getAttribute(activeSel, "aria-current").catch(() => null);
    ok = current === "page";
  }
  results.push({ label, url, ok });
  log(`${ok ? "PASS" : "FAIL"} ${label}; url=${url} aria-current=${ok ? "page" : "MISSING"}`);
  if (!ok) throw new Error(`${label} failed: url=${url}`);
}

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: false,
  args: ["--window-size=1440,900", "--window-position=0,0", "--no-first-run", "--no-default-browser-check"],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("console", (m) => { if (m.text().startsWith("[ws]")) log(`console: ${m.text()}`); });

log(`open ${BASE}/`);
await page.goto(BASE + "/", { waitUntil: "networkidle" });

const tabs = [
  { name: "Token totals", path: "/tokens" },
  { name: "Fleet energy", path: "/energy" },
  { name: "Activity", path: "/activity" },
];

for (const tab of tabs) {
  const sel = `.app-side a[href="${tab.path}"]`;
  await page.click(sel);
  await expectSelected(page, tab.name, tab.path, sel);
  log(`hold ${tab.name} >10s across WS snapshot cycles…`);
  await page.waitForTimeout(11000);
  await expectSelected(page, `${tab.name} (+11s)`, tab.path, sel);
}

// Full page reload retains the last tab (Fleet energy chosen to differ from click order end).
const reloadSel = `.app-side a[href="/energy"]`;
await page.click(reloadSel);
await expectSelected(page, "Fleet energy (pre-reload)", "/energy", reloadSel);
await page.reload({ waitUntil: "networkidle" });
await expectSelected(page, "Fleet energy after reload", "/energy", reloadSel);
await page.waitForTimeout(3000);
await expectSelected(page, "Fleet energy after reload (+3s)", "/energy", reloadSel);

log(results.map((r) => `${r.ok ? "PASS" : "FAIL"} ${r.label}`).join(" | "));
await browser.close();
const failed = results.filter((r) => !r.ok).length;
log(failed === 0 ? "ALL PASS" : `${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
