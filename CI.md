# CI Activation Guide

**Status:** Currently inactive. Workflow `.github/workflows/ble-dfu-test.yml`
exists but is hard-guarded with `if: false` on every job. Follow this guide
when hardware-in-loop (HIL) infrastructure is ready.

The CI tests are hardware-in-loop — they flash firmware, drive real BLE, and
optionally drive a real Chrome instance. GitHub-hosted runners cannot do this.
A self-hosted runner with attached hardware is required.

---

## Prerequisites — HIL host

Recommended: dedicated small Linux box (e.g. Intel NUC) that stays online and
holds the test rig. Don't use your dev workstation — runner has shell access
to whatever it's installed on.

| Item                                                 | Purpose                                                                                                                                            |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux (Ubuntu 22.04+ recommended)                    | Host OS for the runner                                                                                                                             |
| nRF52840 DK via USB                                  | Device under test                                                                                                                                  |
| BLE adapter (built-in or USB dongle)                 | Required for headless + Puppeteer tests                                                                                                            |
| `nrfutil` + nRF Command Line Tools                   | Flashing, recovery                                                                                                                                 |
| Zephyr / NCS workspace (`west init` + `west update`) | Building firmware                                                                                                                                  |
| Node.js 18+                                          | Test harness runtime                                                                                                                               |
| Chrome (system install, optional)                    | Only needed for manual debugging on the host; Puppeteer ships its own bundled Chrome which the tests use                                           |
| `xvfb` / `xvfb-run`                                  | Lets `make browser-test-headless` run Puppeteer Chrome on a headless host (Web Bluetooth needs a headed Chrome against a real or virtual X server) |
| udev rules for stable DK device path                 | Prevents re-enumeration breaking flash step                                                                                                        |

Recovery hardening (important — BLE / DK state accumulates):

- Run `nrfjprog --recover` (or equivalent) as the first step of every job.
- Schedule a weekly host reboot via systemd timer or cron.
- Use a powered USB hub if multiple devices share the bus.

---

## Trust model — why this is gated

Self-hosted runners execute whatever code the triggering ref contains. Without
guards, any pull request — including from forks — would run arbitrary code on
the HIL host with USB access. The trigger config below limits execution to
refs the maintainer controls.

| Source                                  | Runs on       | Hardware?            |
| --------------------------------------- | ------------- | -------------------- |
| Push to `main`                          | self-hosted   | Yes (smoke check)    |
| PR from same repo (collaborator branch) | self-hosted   | Yes (gating check)   |
| PR from fork                            | github-hosted | No — lint/build only |
| `workflow_dispatch`                     | self-hosted   | Yes (manual)         |

Fork PRs are filtered out by an `if:` guard on each hardware job. If an
outside contributor needs hardware validation, the maintainer pulls their
branch into a branch on the main repo and pushes — the runner then treats it
as trusted.

---

## Activation steps

### 1. Register the self-hosted runner

On the HIL host:

```bash
# From repo Settings → Actions → Runners → New self-hosted runner
mkdir actions-runner && cd actions-runner
curl -o actions-runner-linux-x64-<version>.tar.gz -L <url>
tar xzf actions-runner-linux-x64-<version>.tar.gz
./config.sh --url https://github.com/qarnet/web-bluetooth-dfu --token <token>
sudo ./svc.sh install
sudo ./svc.sh start
```

Label the runner (e.g. `hil-nuc`) for clarity if more than one runner exists.

### 2. Edit the workflow file

In `.github/workflows/ble-dfu-test.yml`:

- Remove the `if: false` line from each job.
- Replace the `on:` block with:

  ```yaml
  on:
    pull_request:
      branches: [main]
    push:
      branches: [main]
    workflow_dispatch:
  ```

- Add a top-level concurrency group so parallel jobs queue rather than fight
  over the DK:

  ```yaml
  concurrency:
    group: hardware-runner
    cancel-in-progress: false
  ```

- Add a fork-PR guard as the first condition of each hardware job. Either:

  ```yaml
  if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
  ```

  Or split: keep a separate lightweight job on `runs-on: ubuntu-latest` for
  fork PRs (lint, unit, JS-only checks) and hardware jobs on `self-hosted`
  with the guard above.

- Add a recovery step as the first action of each job:

  ```yaml
  - name: Recover DK
    run: nrfjprog --recover || true
  ```

### 3. Configure branch protection

In repo Settings → Branches → Add rule for `main`:

- Require pull request before merging.
- Require status checks to pass — select the three hardware jobs as required.
- Require branches to be up to date before merging.
- Optionally require linear history.

This is what prevents a "poisoned main": the merge button only activates
after CI is green on the PR.

### 4. (Optional) Manual approval environment

For extra paranoia, configure a GitHub Environment named `hardware` with
required reviewers = yourself. Add `environment: hardware` to each hardware
job. Every run pauses for an explicit click before executing.

### 5. Verify

Push a no-op PR. Confirm:

- The hardware jobs queue on the self-hosted runner (visible in repo Actions tab).
- The status checks block the merge button until green.
- Concurrency queues — push twice quickly, only one job runs at a time.
- A fork PR from a test account runs _only_ the hosted lint/build job, not hardware.

---

## Dev loop without CI

CI is for gating shared branches. **Do not use it as your inner dev loop.**
For active development:

- SSH into the HIL host directly, `git clone`, run `make build && make test`.
- Or expose the host via VS Code Remote-SSH and edit/test in place.
- Or attach the DK to your dev machine for local iteration; use the HIL host
  only as the CI executor.

CI feedback latency (build + flash + test) is far slower than direct local
runs and not worth waiting on for iteration.

---

## Codeberg portability

Codeberg.org runs Forgejo, which supports Forgejo Actions — GitHub
Actions-compatible. The workflow is portable with minor adjustments:

- Replace `actions/checkout@v4` etc. with `code.forgejo.org/actions/checkout@v4`
  (Codeberg doesn't auto-resolve `actions/*` from GitHub).
- Enable Actions for the repo in Codeberg settings.
- Verify Codeberg's free-tier policy allows self-hosted-only Actions usage.

No structural changes to the workflow logic are needed.

---

## Common pitfalls

| Symptom                                        | Cause                                           | Fix                                                                                                                                                              |
| ---------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runner offline mid-job                         | Power save, USB suspend                         | Disable USB autosuspend; keep host plugged in                                                                                                                    |
| `nrfjprog: cannot find device`                 | DK renumerated                                  | Add udev rules pinning serial → stable path                                                                                                                      |
| Puppeteer "Web Bluetooth unavailable"          | Stale bundled Chrome or `HEADLESS=1` set in env | Reinstall: `cd tools && npm install`; ensure `HEADLESS` is not exported. The test already passes `--enable-features=WebBluetoothNewPermissionsBackend` at launch |
| `xvfb-run: command not found` on headless host | Xvfb not installed                              | `apt install xvfb` (Debian/Ubuntu) or add `pkgs.xvfb-run` to the Nix profile                                                                                     |
| Tests pass locally but fail in CI              | BLE state accumulated                           | Add `nrfjprog --recover` recovery step; cron weekly host reboot                                                                                                  |
| Two PRs both stuck                             | Concurrency group misconfigured                 | Verify `concurrency:` is at workflow level, not job level                                                                                                        |
| Fork PR triggered hardware job                 | Missing `if:` guard                             | Add `head.repo.full_name == github.repository` check                                                                                                             |
