# CI/CD pipeline (sparkDash)

## Flow

    PR → validate (GitHub Actions, ubuntu-latest) → merge into release/custom
       → deploy job (GitHub-hosted runner) SSHes into anton → docker compose there
       → smoke checks (via ssh curl on anton) → on failure: 15-min cron DMs gilfoyle

## Components

### 1. PR validation gate — `.github/workflows/pr-validate.yml`

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

### Credential reality check (2026-10-05, t_0f7041be)

Neither host credential can push files under `.github/workflows/`:

- hosts.yml OAuth token (`gho_…`, `gh auth git-credential`): scopes
  `repo` — pushes normal code fine, but GitHub rejects workflow files
  without the `workflow` scope.
- "Anton - Mirego" fine-grained PAT (`github_p…`): **read-only** in
  practice — 403 `Resource not accessible by personal access token` on
  git refs + contents writes (its repo-permissions block reflects the
  owner user, not the token).

Fix (either one, then push the workflow commit of this branch):

    # option A: add workflow scope to the gh CLI token
    gh auth refresh -h github.com -s workflow
    # option B: regenerate the fine-grained PAT with
    # Contents: Read and write + Workflows: Read and write, update
    # GH_TOKEN in every profile .env

### 2. Deploy on merge — `.github/workflows/deploy-release.yml`

On push to `release/custom` (and manual `workflow_dispatch`):

- **runs-on: `ubuntu-latest`** — a GitHub-hosted runner. No self-hosted
  runner is required. (Verified 2026-10-05: a probe workflow ran green on
  `ubuntu-latest`, `ubuntu-24.04` and `ubuntu-22.04` in the mirego org;
  sibling repos accent/trikot/telemetry_ui/elixir-boilerplate also use only
  standard hosted labels.)
- The job does **not** build locally — it **SSHes into the anton host** and
  runs everything there, because that is where the app lives (port 5555)
  and where the anton-local deploy files exist:

      ssh gilfoyle@$ANTON_HOST
        cd ~/sparkDash-deploy
        git fetch --all --prune && git checkout --force <sha> && git clean -ffd
        docker compose -f docker-compose.yml -f docker-compose.override.yml \
                       -f docker-compose.deploy.yml build
        docker compose ... up -d --force-recreate   # never plain restart — FE baked into image

- The anton-local `docker-compose.deploy.yml` + `.env` (live config mounts +
  BIND_HOST=0.0.0.0 PORT=5555) are never copied off anton — the workflow
  verifies they exist, then runs compose in the deploy worktree itself.
- Smoke checks run **on anton via ssh** (loopback curl), unchanged in
  substance: `/` serves a real built bundle, both export endpoints
  (`/api/models/export/opencode`, `/api/models/export/pimono`) return 200
  with env placeholders only (a `sk-…` plaintext key fails the deploy),
  `/api/sparks` parses and reports the registry.

#### Repo secrets required (one-time human step — Gilfoyle)

The deploy token cannot create repo secrets (no `administration:write`);
Settings → Secrets and variables → Actions → New repository secret:

| Secret           | Value                                                                 |
|------------------|-----------------------------------------------------------------------|
| `ANTON_HOST`     | `10.4.0.15`                                                           |
| `ANTON_SSH_KEY`  | PRIVATE half of a dedicated deploy key (ed25519), single line incl. final newline |

One-time setup:

    # 1. generate a dedicated deploy key (NOT gilfoyle's personal key)
    ssh-keygen -t ed25519 -f ~/sparkdash-deploy-key -N "" -C sparkdash-ci-deploy
    # 2. allow it on anton for user gilfoyle:
    cat ~/sparkdash-deploy-key.pub >> ~/.ssh/authorized_keys
    # 3. paste the CONTENTS of ~/sparkdash-deploy-key into the ANTON_SSH_KEY
    #    repo secret (private key — never commit it)

The workflow pins the host key via `ssh-keyscan` (accept-new) and fails
fast with `ssh-keygen -y` if the secret is malformed.

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
validation gate is merged, green on a real PR, and marked required — and
until the `ANTON_HOST` + `ANTON_SSH_KEY` repo secrets are added (see
above). Until then gilfoyle's manual deploy (sparkdash-factory skill,
"Deploy stage") is the flow of record; adding the repo secrets +
branch-protection click are the remaining one-time human steps.
