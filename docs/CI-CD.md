# CI/CD pipeline (sparkDash)

## Flow

    PR → PR Validate (GitHub Actions, ubuntu-latest) → merge into release/custom
       → merge-tracker cron detects the merge → files the Release-train card
       → deploy runs locally on anton (gilfoyle: docker compose) → smoke checks

## Deploy model

GitHub Actions is **CI-only**: the single workflow is the PR Validate gate.
**Deploys are NOT GitHub-driven** — there is no deploy workflow and no runner
ever SSHes anywhere. The flow after merge:

- The merge-tracker cron (merge-poll) detects merges into `release/custom`
  and files the **Release-train card** on the sparkDash board for gilfoyle.
- gilfoyle runs the deploy **locally on anton** from the `~/sparkDash-deploy`
  worktree (its `docker-compose.deploy.yml` + `.env` carry the live config
  mounts and `BIND_HOST=0.0.0.0 PORT=5555` — those files are never copied
  off anton):

        docker compose -f docker-compose.yml -f docker-compose.override.yml \
                       -f docker-compose.deploy.yml build
        docker compose ... up -d --force-recreate   # never plain restart — FE baked into image

- Post-deploy smoke checks on anton (loopback curl): `/` serves a real
  built bundle, both export endpoints (`/api/models/export/opencode`,
  `/api/models/export/pimono`) return 200 with env placeholders only (a
  `sk-…` plaintext key fails the check), `/api/sparks` parses and reports
  the registry.

**No repo secrets are required for CI** — nothing in `.github/workflows/`
reads a secret; the deploy path touches GitHub only through the merge-tracker
polling API.

## PR Validate — the only workflow: `.github/workflows/pr-validate.yml`

Runs on every pull_request targeting `release/custom`:

- `npm run test:server` (node --test)
- `npm run test:frontend` (vitest run)
- `npx tsc --noEmit`
- `npm run build` (vite build — proves the FE bakes)

The e2e suite is **not** part of the gate: it needs CPA API credentials, the
live config files and a real browser runner (TesterArmy framework) — see
"why e2e stays local" below. Reviewers run e2e locally
against the PR staging pattern (sparkdash-factory skill, "PR staging for
e2e"). The gate proves test/tsc/build on every PR; e2e proof lives in
the review round (videos attached to the PR).

Once this workflow is green on a real PR, mark its check required:

    Settings → Branches → release/custom → Require status checks
    → "Validate PR (test / tsc / build)"

(Note: the fine-grained PAT has no `administration:write`, so branch
protection must be clicked by a human admin.)

## Why e2e stays local

The TesterArmy e2e suite (e2e.config.ts + tests/*.e2e.ts, lives in the
`sparkDash-deploy` worktree on anton) targets a running server and needs:

- a real browser (Chromium + the TesterArmy runner),
- CPA_API_KEY for the fleet model (a repo secret would leak fleet tokens to
  every contributor's log — against the zero-plaintext-credentials rule),
- the anton-local config files (sparks.json, gpu-memory, token-lifetimes,
  llm-daily, model-registry) so the UI isn't tested against an empty
  registry — the "PR staging for e2e" pitfall in the sparkdash-factory skill.

In CI the app would start with scratch config and fail for env reasons, not
PR reasons. So the validation gate proves test/tsc/build; e2e proof is
produced during review (videos attached to the PR) and re-run post-deploy
against live :5555.
