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
 * (label = the auth-proxy key prefix, e.g. `sbre ×3 · …`), fed by the WS
 * snapshot's llm[].activeUsers[].openRequests. The old Model Fleet panel mount
 * was removed from Overview (2cfa1e7 + t_db6255db); it must NOT be awaited here.
 *
 * Key derivation (t_242cd25c): the expected key must come from LIVE in-flight
 * state — a key that actually has an OPEN request on a monitored Spark, read
 * from the same WS snapshot the pills render from. It is NOT
 * /api/models/fleet usage.users[0]: that is ranked by HISTORICAL request count,
 * so it can name a key with nothing in flight (sbre) while the only open
 * request belongs to another key (hermes), which made this test fail on a live
 * box for reasons unrelated to the product. (Note: /api/sparks/:id/metrics does
 * NOT carry activeUsers — buildSnapshotPayload() attaches it for the WS
 * snapshot only — so the WS frame is the right REST-free source here.)
 *
 * Headed recording: launch with HEADED=1 on a real display (Xvnc :20);
 * Playwright writes an mp4 per test into test-results/ via video: "on"
 * (set E2E_VIDEO=1).
 */
import { test, expect, type Page } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:5610";

type OpenRequest = {
  label?: string;
  phase?: string;
  promptEstTokens?: number | null;
  completionEstTokens?: number | null;
};
type ActiveUser = { label?: string; openRequests?: OpenRequest[] };
type LlmEntry = { activeUsers?: ActiveUser[] };

/** First snapshot frame from the dashboard WS — the same payload the Overview Spark card renders from. */
async function wsSnapshot(page: Page): Promise<{
  sparks: Array<{ id: string; metrics?: { llm?: LlmEntry[] } }>;
}> {
  return page.evaluate(
    (wsUrl: string) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error("no snapshot within 10s"));
        }, 10_000);
        ws.onmessage = (ev) => {
          const msg = JSON.parse(String(ev.data));
          if (msg.type !== "snapshot") return;
          clearTimeout(timer);
          ws.close();
          resolve(msg);
        };
        ws.onerror = () => {
          clearTimeout(timer);
          reject(new Error("ws error"));
        };
      }),
    `${BASE.replace(/^http/, "ws")}/ws`,
  );
}

/**
 * Keys with at least one OPEN request right now, across every Spark in the
 * snapshot (llm[].activeUsers[].openRequests — the exact rows InflightReqPills
 * renders; note the pill label comes from the activeUser's `label`, the
 * auth-proxy key prefix — openRequests entries carry no label of their own).
 * A key with no open request must never be expected as a pill label.
 */
async function liveInflightKeys(page: Page): Promise<string[]> {
  const snap = await wsSnapshot(page);
  const keys: string[] = [];
  for (const spark of snap.sparks ?? []) {
    for (const entry of spark.metrics?.llm ?? []) {
      for (const user of entry.activeUsers ?? []) {
        const open = (user.openRequests ?? []).filter((r) => r && typeof r === "object");
        if (open.length === 0 || !user.label) continue;
        if (!keys.includes(user.label)) keys.push(user.label);
      }
    }
  }
  return keys;
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

  test("Overview Spark card in-flight pills show the api key, prefix-masked", async ({ page }) => {
    // Derive the expected key from LIVE in-flight state: a key that actually
    // has an OPEN request on a monitored Spark right now. Historical usage
    // ranking (/api/models/fleet usage.users[0]) is order-dependent and can
    // name a key with nothing in flight, so it is not used here.
    const liveKeys = await liveInflightKeys(page);

    // No open request anywhere is a valid deployment state, not a failure: the
    // d-002 chain is then covered by the API-level test above (key prefix
    // reaches the client) + the SparkCard vitest suite (prefix-only rendering),
    // so skip by design with an explicit reason instead of failing or passing.
    test.skip(
      liveKeys.length === 0,
      "no key has an OPEN in-flight request on any monitored Spark right now — nothing to assert on the pills; d-002 UI path covered by SparkCard vitest + fleet API test",
    );

    const expected = liveKeys[0];

    await page.goto(`${BASE}/`);
    const pills = page.locator('[data-testid="inflight-req-pills"] .tag');
    // The request was open moments ago in the snapshot; give the UI render a
    // moment, then assert the live key really appears on a pill.
    const hasTraffic = await pills
      .first()
      .waitFor({ state: "visible", timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    expect(
      hasTraffic,
      `a key had an open request (${liveKeys.join(", ")}) but no in-flight pill rendered on the Overview Spark card`,
    ).toBe(true);

    const labels = await pills.allTextContents();
    const matching = labels.filter((t) => t.startsWith(expected));
    expect(
      matching.length,
      `expected the live in-flight key ${expected} to appear as a pill label; got: ${labels.join(" | ")}`,
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
