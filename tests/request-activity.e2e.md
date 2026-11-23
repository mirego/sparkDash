# Fleet LLM request lifecycle in Activity: E2E results (t_98955a1d)

## What is covered
- **Spec:** `tests/request-activity.e2e.ts` (Playwright, 2 tests, run serially).
- **Isolated stack:** `tests/fixtures/request-activity-stack.sh` starts the fake auth-proxy `/inflight` (`tests/fixtures/fake-inflight.mjs`, legacy shape like production today) and the branch server.
  - Ports: fake proxy on `:18317`, branch server on `:5611`.
  - Config: temporary, with two Sparks and one seeded ordinary event ("Anton came online").
  - It never touches `:5555`, `:8317`, or the real `config/`.

## How to run
```bash
npm run build
E2E_DIR=$TMPDIR/t989-e2e bash tests/fixtures/request-activity-stack.sh &
DISPLAY=:20 HEADED=1 E2E_VIDEO=1 \
  E2E_BASE_URL=http://127.0.0.1:5611 FAKE_INFLIGHT_URL=http://127.0.0.1:18317 \
  npx playwright test tests/request-activity.e2e.ts --timeout 90000
```

## Results (headed, Xvnc :20, Chromium, 2026-11-23)
`2 passed (44.2s)`. The headless run beforehand also passed 2/2.

1. **Root Overview → Recent activity:**
   - **Load:** two requests that were already open load into a pinned "Open LLM requests" group. It shows count 2, newest start first, and sits above the ordinary event row.
   - **Row fields:** each row shows Spark, key, model, Pending/Active chip, prompt estimate, `out — / max 4,096`, and age.
   - **Legacy note:** shown.
   - **New start:** a request started while the page was open appears within one poll.
   - **Phase change:** Pending → Active.
   - **Finish:** the finished request leaves the pinned group and shows up in the history as Completed · Outcome: Unknown, newest first above the older system event.
   - **Proxy outage:** the count becomes "—" with "Proxy unavailable — open requests unknown", the rows are tagged Stale, and no synthetic completion is recorded.
   - **Recovery:** the count returns to 2 with no duplicate history rows.
2. **Full Activity page:**
   - **Same records:** the page shows the same data, with the pinned panel above the timeline.
   - **Finish:** a request finished while on the page moves into the timeline.
   - **"LLM requests" category:** keeps the request rows and hides the system event.
   - **"Status" category:** hides the request rows and the pinned panel and keeps the system event.
   - **`DELETE /api/events`:** removes the finished request rows. The request that is still open stays pinned.
3. **Privacy:** both tests assert that the page HTML has no request ids (`req-secret-*`) and no upstream path.

Recordings are attached to the card and linked from the PR:
- `t98955a1d-overview-recent-activity.mp4`
- `t98955a1d-activity-page.mp4`

## Limitation with the current proxy
The production auth-proxy serves the legacy `/inflight` shape. Its `recent` ring has no outcome field, so every finished request reads **Completed · Outcome: Unknown**. The UI says so. When the schema-v2 proxy is installed (a separate gate), its `recent[].outcome` is shown as given:
- completed
- upstream error
- client disconnected
- cancelled
- upstream unreachable

None of these is inferred.
