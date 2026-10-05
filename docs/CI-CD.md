# CI/CD pipeline (sparkDash)

## Flow

    PR → validate (GitHub Actions) → merge into release/custom
       → auto-deploy on anton (self-hosted runner)
       → smoke checks → on failure: 15-min cron DMs gilfoyle

## Components

### 1. PR validation gate — `.github/workflows/pr-validate.yml`

Runs on every pull_request targeting `release/custom`:

- `npm run test:server` (node --test)
- `npm run test:frontend` (vitest run)
- `npx tsc --noEmit`
- `npm run build` (vite build — proves the FE bakes)

The e2e suite is **not** part of the gate: it needs CPA API credentials, the
live config files and a real browser runner (TesterArmy framework) — see
`docs/CI-CD.md` "Why e2e stays local" above. Reviewers run e2e locally
against the PR staging pattern (sparkdash-factory skill, "PR staging for
e2e"). The gate proves test/tsc/build green on every PR; e2e proof lives in
the review round (videos attached to the PR).

Once this workflow is green on a real PR, mark its check required:

    Settings → Branches → release/custom → Require status checks
    → "Validate PR (test / tsc / build)"

(Note: the fine-grained PAT has no `administration:write`, so branch
protection must be clicked by a human admin.)

### 2. Deploy on merge — `.github/workflows/deploy-release.yml`

On push to `release/custom` (and manual `workflow_dispatch`):

- runs-on `[self-hosted, anton]` — requires a registered runner:

      # one-time, on anton (human: generate registration token in
      # Settings → Actions → Runners → New self-hosted runner)
      mkdir ~/actions-runner && cd ~/actions-runner
      ./config.sh --url https://github.com/mirego/sparkDash --token <TOKEN> --labels anton
      ./svc.sh install gilfoyle && ./svc.sh start

- Stages the anton-local `docker-compose.deploy.yml` + `.env` from
  `/home/gilfoyle/sparkDash-deploy` into the runner workdir (they are not in
  the repo — live config mounts + BIND_HOST=0.0.0.0 PORT=5555).
- `docker compose -f docker-compose.yml -f docker-compose.override.yml -f
  docker-compose.deploy.yml build` then `up -d --force-recreate` (never plain
  restart — the FE is baked into the image).
- Smoke: loopback `/` serves a real built bundle, both export endpoints
  (`/api/models/export/opencode`, `/api/models/export/pimono`) return 200
  with env placeholders only (a `sk-…` plaintext key fails the deploy),
  `/api/sparks` parses and reports the registry.

### 3. Failure watcher — `deploy-watch.py` (profiles/dinesh/scripts/)

Registered as cron `sparkdash-deploy-watch` (15-min family, zero LLM tokens):

    hermes cron create --name sparkdash-deploy-watch \
      --script deploy-watch.py --no-agent --deliver bot-chat:gilfoyle '*/15 * * * *'

Polls the latest `deploy-release.yml` run via `gh api`; if `conclusion ==
failure` and that run id hasn't been notified yet, the script PRINTS the
alert to stdout — the cron gateway delivers it verbatim into gilfoyle's Bot
Chat (empty stdout = silent, same convention as merge-poll.py):

> Message from 🤖 deploy-watcher (@deploy-watcher): deploy-release failed at
> <run_url> — fix the release.

Idempotent via `~/.hermes/factory/deploy-watch.json` (last notified run id);
a successful or newer run clears the latch so each new failure notifies
exactly once. A 404 on the runs endpoint (workflow not yet on the default
branch) is treated as "no runs" and stays silent.

### Why e2e stays local

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

## Sequencing (safety)

The deploy workflow is committed but **not to be relied on** until the
validation gate is merged, green on a real PR, and marked required. Until
then gilfoyle's manual deploy (sparkdash-factory skill, "Deploy stage") is
the flow of record; the runner registration + branch-protection click are the
remaining one-time human steps.
