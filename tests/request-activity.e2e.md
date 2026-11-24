# Fleet LLM request lifecycle in Activity: E2E results (t_98955a1d, Overview updated for t_3c1594c0)

## What is covered
- **Spec:** `tests/request-activity.e2e.ts` (Playwright, 2 tests, run serially).
- **Isolated stack:** `tests/fixtures/request-activity-stack.sh` starts the fake auth-proxy `/inflight` (`tests/fixtures/fake-inflight.mjs`, legacy shape like production today) and the branch server.
  - Ports: fake proxy on `:18317`, branch server on `:5611`.
  - Config: temporary, with two Sparks and one seeded ordinary event ("Anton came online").
  - It never touches `:5555`, `:8317`, or the real `config/`.

## How to run
```bash
npm run build
E2E_DIR=$TMPDIR/t3c-e2e bash tests/fixtures/request-activity-stack.sh &
DISPLAY=:20 HEADED=1 E2E_VIDEO=1 \
  E2E_BASE_URL=http://127.0.0.1:5611 FAKE_INFLIGHT_URL=http://127.0.0.1:18317 \
  npx playwright test tests/request-activity.e2e.ts --timeout 120000
```

## Results (headed, Xvnc :20, Chromium, 2026-11-24, t_3c1594c0)
`2 passed (45.6s)`.

1. **Root Overview → Recent activity (one flat timeline, t_3c1594c0):**
   - **Flat DOM:** the card has no pinned "Open LLM requests" section. It has one `<ul>`, and every row is a direct `<li>`. No row contains another list or row.
   - **Load:** two requests that were already open appear as rows in the same list as the seeded system event, above it, because they are newer.
   - **Row format:**
     - Line 1: Spark name (a link) and the duration or age. Completed rows also show the outcome on line 1.
     - Line 2: green key chip first, then model, `prompt ~5,200`, `out — / max 4,096`, and the Pending/Active/Completed chip last.
     - The test measures that at the default 1440px viewport every request row is exactly two visual lines.
   - **Legacy note:** shown.
   - **New start:** a request started while the page was open appears within one poll.
   - **Phase change:** the trailing chip changes from Pending to Active.
   - **Finish:** the request becomes a row with a trailing Completed chip and `Outcome: Unknown (legacy proxy)`. It sits above the older system event. Still-open rows that were seen again on later polls move above it, so the list is interleaved by time, not pinned.
   - **Proxy outage:** the card shows "Proxy unavailable — open requests unknown". The open rows are tagged Stale. No synthetic completion is recorded.
   - **Recovery:** the state line goes away, two open rows remain, and there are no duplicate completed rows.
   - **Spark navigation:** a click on the Spark name in a request row opens `/spark/son-of-anton`.
2. **Full Activity page (unchanged by t_3c1594c0):**
   - **Same records:** the page shows the same data, with the pinned panel above the timeline.
   - **Finish:** a request finished while on the page moves into the timeline.
   - **"LLM requests" category:** keeps the request rows and hides the system event.
   - **"Status" category:** hides the request rows and the pinned panel and keeps the system event.
   - **`DELETE /api/events`:** removes the finished request rows. The request that is still open stays pinned.
3. **Privacy:** both tests assert that the page HTML has no request ids (`req-secret-*`) and no upstream path.

Recordings are attached to card t_3c1594c0 and linked from the PR:
- `t3c1594c0-overview-flat-timeline.mp4`
- `t3c1594c0-activity-page.mp4`

## Limitation with the current proxy
The production auth-proxy serves the legacy `/inflight` shape. Its `recent` ring has no outcome field, so every finished request reads **Completed** with **Outcome: Unknown (legacy proxy)**. When the schema-v2 proxy is installed (a separate gate), its `recent[].outcome` is shown as given:
- completed
- upstream error
- client disconnected
- cancelled
- upstream unreachable

None of these is inferred.
