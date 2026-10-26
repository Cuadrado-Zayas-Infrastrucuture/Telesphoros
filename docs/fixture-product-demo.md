# Fixture-backed product walkthrough

This local walkthrough connects real report storage to clearly labeled fixed PGx screens. Engine implementation is deferred. It runs only at `127.0.0.1` in an explicitly opted-in storage-demo build, with synthetic data and clinical processing disabled.

## Start

Follow [Start here](start-here.md#1-prepare-the-tools) for Node 22.22.0, pnpm 10.28.0, PostgreSQL 16, Moto and the absolute `LOCAL_PG_BIN`/`MOTO_SERVER` paths. Use the same free loopback ports and owned lifecycle.

Build the fixture-backed variant, then start the existing storage launcher:

```sh
pnpm demo:product:build
pnpm demo:storage
```

The product build adds `VITE_SYNTHETIC_PGX_DEMO=true` to the existing storage build. Ordinary `pnpm build` and `pnpm demo:storage:build` omit the fixed-result screens. No reader, model, backend pipeline or external service is enabled.

## Rehearse

1. Open the reported loopback address, sign in through the fake identity provider as Alice, and choose **Upload report**.
2. Choose **Add a synthetic patient** if the roster is populated. Add patient `SYN-DEMO-01`, select **Lab report (PDF)**, choose [D01/source.pdf](../data/fixtures/lab-reports/captures/D01/source.pdf), confirm synthetic-only data and upload.
3. Choose **View reports**, open the report, and inspect the real storage status. Under **PGx demo**, choose **Show fixed sample result**. D01 shows copied synthetic gene inputs and invented Drug Q/R output, with source and no-processing disclosures.
4. Repeat with patient `SYN-DEMO-08` and [D08/source.pdf](../data/fixtures/lab-reports/captures/D08/source.pdf). Open the report and choose **Show held sample**. The fixed example shows `alignment-unsupported` and no gene/drug result.
5. Other PDFs have no fixed example. A filename alone never selects a result; only a completed lab-PDF upload with a known server-verified SHA-256 matches. Switching reports/file fingerprints resets the open sample.
6. Verify keyboard operation, close/hide controls, narrow-screen reflow and the unchanged authorized file download. Stop using the owned [storage lifecycle](ops/local-storage-operations.md#written-teardown-blast-radius-check).

## What the demo establishes

| Real behavior | Fixed demonstration |
|---|---|
| Fake-IdP authentication and existing role restrictions | D01 gene inputs and invented Drug Q/R output |
| Patient creation, validated API upload, PostgreSQL metadata and versioned local S3 storage | D08 held layout example |
| Server-verified file hash and existing authorized download | Source copied from the hand-authored [adapter oracle](../tests/report_adapter/golden.json), not extracted from this upload |

These values are not CPIC guidance or clinical advice. Opening a sample makes no capture, review, evaluation, ledger or model request. It records no independent approval and does not turn upload verification into clinical acceptance. All states are display-only and reset when the selected report/file changes.

## Browser regression

With the explicitly owned product-demo stack already running in another terminal:

```sh
pnpm test:product-demo
```

This reuses the existing fake-IdP browser helpers and runs D01/D08 upload-to-sample controls at 375px and 1280px against the fixed loopback URL. It starts/stops no services. Tests check the stored hash, fixed/held outputs, no page processing requests, a real pipeline-disabled refusal, keyboard controls and reflow. Traces are disabled. Set `PRODUCT_DEMO_SCREENSHOTS=true` to retain synthetic-only result/held screenshots under the existing ignored test-results directory.

## Deferred engine work

The next session can design the permitted reader/engine boundary and computed-result integration. Actual extraction, independent review persistence, computation, clinical knowledge validation, model explanations, hosted operation and clinical approval are not established by these fixed screens.
