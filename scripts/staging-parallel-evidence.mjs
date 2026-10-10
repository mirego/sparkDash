/**
 * Staging parallel-run UI evidence (t_56eaca67):
 * exercises Export Configs + api-key display on staging :5610, capturing
 * screenshots and the generated config outputs as files.
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:5610";
const OUT = "/home/gilfoyle/.hermes/kanban/boards/sparkdash/workspaces/t_56eaca67/evidence/parallel";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();

// 1. Overview loads
await page.goto(`${BASE}/`);
await page.getByText("Model Fleet").first().waitFor({ state: "visible", timeout: 20000 });
await sleep(1500);
await page.screenshot({ path: `${OUT}/staging-overview.png`, fullPage: false });

// 2. Expand model row -> api-key display
const fleet = await (await page.request.get(`${BASE}/api/models/fleet`)).json();
const model = fleet.models.find((m) => (m.usage?.users ?? []).length > 0);
const user = model.usage.users[0];
const shown = user.apiKeyPrefix || user.label;
await page.locator("button", { hasText: model.id }).first().click();
const entry = page.locator('span[title^="API key:"]', { hasText: shown }).first();
await entry.waitFor({ state: "visible", timeout: 10000 });
await entry.hover();
await sleep(1200);
await page.screenshot({ path: `${OUT}/staging-apikey-display.png` });
console.log("apikey display OK:", shown, "title:", await entry.getAttribute("title"));

// 3. Export Configs modal — capture generated configs
await page.locator('button[title="Copy agent CLI configs (opencode / pi-mono) pointing at the CPA fleet endpoint"]').click();
await page.getByTestId("agent-config-tab-opencode").waitFor({ state: "visible", timeout: 10000 });
await sleep(1500);
await page.screenshot({ path: `${OUT}/staging-export-opencode.png` });
const opencodeText = await page.getByTestId("agent-config-section-opencode").textContent();
await page.getByTestId("agent-config-tab-pimono").click();
await sleep(1500);
await page.screenshot({ path: `${OUT}/staging-export-pimono.png` });
const pimonoText = await page.getByTestId("agent-config-section-pimono").textContent();

fs.writeFileSync(`${OUT}/staging-opencode-generated.json.txt`, opencodeText);
fs.writeFileSync(`${OUT}/staging-pimono-generated.json.txt`, pimonoText);
JSON.parse(opencodeText.slice(opencodeText.indexOf("{"))); // throws if invalid
JSON.parse(pimonoText.slice(pimonoText.indexOf("{")));
console.log("Export Configs OK: both configs parse as JSON; screenshots + outputs saved");
await browser.close();
