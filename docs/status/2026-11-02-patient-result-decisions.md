# Patient result decisions and linked follow-up
Date: 2026-11-02

Founder clarification: the report-reader engine is not designed yet. Historical imported-reader references and test stand-ins do not establish an available product engine. Actual extraction and clinical validation remain separate work; no test reader was activated for the investor prototype.

The patient record now offers an on-demand Recorded results section using stored evaluation APIs, including historical/held/retracted/disputed state and source provenance. Clinical users can read decision history; clinicians can record the existing response vocabulary, correct or withdraw their own latest entry, and schedule a follow-up explicitly linked to the current decision. The physician chooses the recorded medication and reminder details. This adds no separate page or inference dependency.

An uncertain save retains the exact payload for idempotent retry. A stale history or basis preserves the draft without automatic rebasing. Filtered patient reads and decision histories verify their patient/evaluation/result binding. Disabled processing is distinct from an empty result or temporary error. Existing server authorization, ledger, schema and pipeline gates remain unchanged.

AI generated implementation and tests. [Plan](../design/plans/patient-result-decisions.md), [verification](../verification/patient-result-decisions.md). Local synthetic work only; no publication or deployment.
