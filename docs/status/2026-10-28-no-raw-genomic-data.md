# No raw genomic data: VCF uploads removed (local)

Date: 2026-10-28

**Decision.** The founder, 2026-10-28: *"we will not store raw data, for research purposes a curated database has way more value"*. Two report types remain:
- `structured`, the curated JSON report, which is kept;
- `lab-pdf`.

A VCF upload had been accepted and stored but never interpreted (M0.1 plan, I2).

**What changed.**
- **Database:** migration 0058 (`-- compat: breaking`) removes `vcf` from `reports_type_valid` and `report_upload_attempts_type_check`. A database that holds a VCF report or upload attempt refuses the migration and is left unchanged; no row is ever rewritten.
- **API:** the shared schema refuses `vcf` and `.vcf`. The structural validator refuses any type other than the two before reading a byte.
- **Frontend:** the upload screens offer structured JSON (and lab PDF in owned local-storage mode), and the copy says raw genomic files are not accepted.
- **Evidence and recovery:** the catalogues and recovery checks count three kinds, `lab-pdf`, `structured` and `text`, and the CI fixtures were updated to match.
- **Repository:** the empty `data/sample-reports/vcf` folder and its `.gitignore` exception are gone; `*.vcf` stays ignored.

**Not changed.** The engine, evaluations, CPIC content and the `structured` format itself. The M0.1 plan amendment is a separate docs PR.

Verification: [no-raw-genomic-data.md](../verification/no-raw-genomic-data.md).
