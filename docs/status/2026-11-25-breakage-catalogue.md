# Deliberate breakages: one catalogue and a runner for the sandbox

Date: 2026-11-25

Built on the founder's choice of 2026-11-25 ("a catalogue and a runner"). The breakages that several slices left open (N2 to N4, B2,
W1, W2, H1, H2, patient search B and C, RC1a and RC1b) are now 67 entries in `scripts/breakages/catalogue.json`. `run.mjs` applies one at a
time inside a sealed sandbox job, runs the guarding tests, always restores the file, and prints a results table.

Records: [the catalogue page](../verification/breakages.md). Open: the founder's sandbox run, then the browser tier (3 entries) where a
browser exists. No product code, test, API, migration or Terraform change.
