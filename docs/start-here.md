# Start here

Run the local storage demo first. It gives you sign-in, synthetic patients, report upload and the Reports page using PostgreSQL and a local S3 emulator. It runs entirely on your computer with clinical processing disabled.

## 1. Prepare the tools

Use Node **22.22.0**, pnpm **10.28.0**, PostgreSQL **16**, Python with `venv` and `pip`, and the `lsof` and `ps` commands. The commands below were checked on macOS with Python **3.14.6**; use its `python3.14` executable. Install these tools before starting. Keep production configuration out of this local-development shell.

```sh
git clone https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros.git
cd Telesphoros
node --version
pnpm --version
pnpm install --frozen-lockfile
python3.14 -m venv .venv
.venv/bin/python -m pip install -r .github/ci/requirements.in
```

The first two version commands should report `v22.22.0` and `10.28.0`. Select the pinned Node version before installing dependencies. The repository's `packageManager` field pins pnpm.

The local emulator input pins Moto **5.2.4** in [requirements.in](../.github/ci/requirements.in). CI uses the fully hashed [requirements.txt](../.github/ci/requirements.txt), generated for Python 3.12 on Linux; the local command above resolves dependencies for your Python environment.

Set the absolute paths to PostgreSQL 16's binary directory and this checkout's Moto executable. On macOS with Homebrew PostgreSQL 16:

```sh
export LOCAL_PG_BIN="$(brew --prefix postgresql@16)/bin"
export MOTO_SERVER="$(pwd -P)/.venv/bin/moto_server"
"$LOCAL_PG_BIN/postgres" --version
.venv/bin/python -c 'import importlib.metadata; print(importlib.metadata.version("moto"))'
```

The outputs should identify PostgreSQL 16 and Moto 5.2.4. For another PostgreSQL installation, set `LOCAL_PG_BIN` to its absolute binary directory instead. The launcher starts an independent disposable cluster; an existing PostgreSQL service is unnecessary.

## 2. Build and start

The demo needs free loopback ports: **54481** (PostgreSQL), **5557** (Moto), **3010** (API), **4010** (fake identity provider) and **4173** (browser).

```sh
pnpm demo:storage:build
pnpm demo:storage
```

Keep the second command running. Wait for `Synthetic storage ready: http://127.0.0.1:4173; run <UUID>`, then open **http://127.0.0.1:4173**. Save the run UUID if you need a separate teardown command.

Setup creates its own database, local bucket, organizations and fake-user memberships. It supplies its own synthetic configuration; AWS credentials, a real identity provider and an application `.env` file are unnecessary for this demo.

## 3. Walk through the product

1. Open **Sign in**, use its **Sign in** button, then choose **Sign in as alice** in the fake identity provider. Alice is the synthetic clinician in organization `alpha`.
2. Open **Upload report**. Under **Add a synthetic patient**, enter `SYN-ONBOARDING-01` in **Synthetic patient label**, then choose **Add patient**. The new patient is selected automatically.
3. Set **Report type** to **Lab report (PDF)**, then choose the original synthetic PDF at [data/fixtures/lab-reports/captures/D01/source.pdf](../data/fixtures/lab-reports/captures/D01/source.pdf) from your checkout. Confirm **synthetic data only**, then choose **Upload report**.
4. Open **Reports** and confirm that `source.pdf` appears for `SYN-ONBOARDING-01`, with upload status **Verified**. File storage and verification are the goal of this walkthrough; the storage demo does not run capture review, evaluation or a live model.

Use only repository fixtures and fictional labels. The fake identity provider is a local test component. Its users have different roles and organizations; use Alice for this walkthrough.

## 4. Stop and start fresh

Press **Ctrl-C** in the foreground demo terminal and wait for it to exit. This stops the owned services and removes that run's synthetic database, uploaded files and temporary state. A later `pnpm demo:storage` starts a new empty run.

If the foreground terminal was lost, use the saved UUID from the **same checkout**:

```sh
pnpm demo:storage:teardown <run-UUID>
```

Before disposing of an existing run, read its `.local-storage/runs/<UUID>/blast-radius.md`. Teardown checks ownership and preserves unrelated processes and directories. Details: [local storage operations](ops/local-storage-operations.md).

## 5. Run the developer checks

After stopping the demo, run the checks from [CONTRIBUTING.md](../CONTRIBUTING.md#development-setup):

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:infra
pnpm test:ci-config
pnpm check:workflows
```

The default test command explicitly skips database and S3 suites without their service configuration. Use the [database guide](database.md) and [local test commands](STATUS.md#running-things-locally) for those tiers. Starting the demo is separate from running the integration suites.

## If setup stops

- **Wrong Node or Moto version:** check the version commands above and use the same Python environment as `MOTO_SERVER`.
- **A required port is occupied:** stop the other run through its own documented command or choose a different session. The launcher refuses occupied ports; killing a process by port can interrupt unrelated work.
- **A required path is missing:** both `LOCAL_PG_BIN` and `MOTO_SERVER` must be absolute paths. Confirm that `postgres`, `initdb` and `pg_ctl` are in the selected PostgreSQL directory.
- **A service failed during startup:** inspect the private `.local-storage/control/` failure logs. Keep connection values, tokens and private logs out of issues and shared output.
- **Looking for the full report-review flow:** [the lab-report pipeline](lab-report-reader.md) has additional reader and clinical gates. `demo:review` requires reader captures absent from this public checkout; use the storage demo for onboarding.

Continue with the [documentation map](README.md), [architecture](architecture.md) and [glossary](glossary.md).
