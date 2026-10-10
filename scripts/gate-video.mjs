/**
 * Continuous headed recording for OPin's standing gate (t_56eaca67):
 * one Chromium session on Xvnc :20 showing, in one take:
 *   1. 2.0 shell loads (Overview)
 *   2. Model Fleet panel — expand deployed model row
 *   3. api-key-in-use entry with masked "API key: <prefix>-***" tooltip
 *   4. Export Configs modal: opencode + pi-mono tabs with generated configs
 * Writes gate-video.webm (transcoded to mp4 via ffmpeg if available).
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:5610";
const OUT = process.env.GATE_VIDEO_OUT || "/home/gilfoyle/.hermes/kanban/boards/sparkdash/workspaces/t_56eaca67/evidence/gate-video.webm";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: "/home/gilfoyle/.hermes/kanban/boards/sparkdash/workspaces/t_56eaca67/evidence", size: { width: 1440, height: 900 } },
});
const page = await context.newPage();
try {
  await page.goto(`${BASE}/`);
  await page.getByText("Model Fleet").first().waitFor({ state: "visible", timeout: 20000 });
  await sleep(2500);

  // Pick the model with tracked users from the live API.
  const fleet = await (await page.request.get(`${BASE}/api/models/fleet`)).json();
  const model = fleet.models.find((m) => (m.usage?.users ?? []).length > 0);
  const user = model.usage.users[0];
  const shown = user.apiKeyPrefix || user.label;

  const row = page.locator("button", { hasText: model.id }).first();
  await row.click();
  const entry = page.locator('span[title^="API key:"]', { hasText: shown }).first();
  await entry.waitFor({ state: "visible", timeout: 10000 });
  // Hover the api-key entry so the masked tooltip renders on camera.
  await entry.hover();
  await sleep(3000);

  // Export Configs modal: both tabs on camera.
  await page.locator('button[title="Copy agent CLI configs (opencode / pi-mono) pointing at the CPA fleet endpoint"]').click();
  await page.getByTestId("agent-config-tab-opencode").waitFor({ state: "visible", timeout: 10000 });
  await sleep(3000);
  await page.getByTestId("agent-config-tab-pimono").click();
  await sleep(3000);
  await page.getByTestId("agent-config-tab-opencode").click();
  await sleep(2500);

  console.log("GATE OK: api-key entry shown =", shown, "| model =", model.id);
} finally {
  await context.close();
  await browser.close();
}
// The recording lands as a random-named .webm; keep the newest one.
const files = fs.readdirSync("/home/gilfoyle/.hermes/kanban/boards/sparkdash/workspaces/t_56eaca67/evidence")
  .filter((f) => f.endsWith(".webm"))
  .map((f) => ({ f, m: fs.statSync(`/home/gilfoyle/.hermes/kanban/boards/sparkdash/workspaces/t_56eaca67/evidence/${f}`).mtimeMs }))
  .sort((a, b) => b.m - a.m);
fs.renameSync(`/home/gilfoyle/.hermes/kanban/boards/sparkdash/workspaces/t_56eaca67/evidence/${files[0].f}`, OUT);
console.log("VIDEO:", OUT, fs.statSync(OUT).size, "bytes");
