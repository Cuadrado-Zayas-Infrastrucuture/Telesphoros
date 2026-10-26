# Fixture-backed product walkthrough

Date: 2026-10-26

Added an explicitly opted-in loopback product-demo build that reuses the existing authenticated storage flow and report drawer. Known server-verified D01/D08 PDF hashes select display-only fixed result/held examples copied from the hand-authored synthetic oracle. Unknown/incomplete/non-PDF uploads receive no sample result. Normal builds omit the screens; existing roles, downloads and backend pipeline gates remain unchanged.

The UI labels every sample as fixed synthetic data with no reader/rules/model execution. It creates no capture approval, independent review, evaluation or ledger entry. Engine implementation remains deferred to a separate session. No clinical rules, knowledge source, backend, schema, infrastructure, hooks or model integration changed.

The focused regression failed at the missing sample control before implementation and passed unchanged afterward. Additional controls cover D08 with no drug/gene output, filename/unknown-hash refusal, build/host gates, selection reset, accessibility and zero processing requests. All seven required local commands passed. Six real PostgreSQL/Moto browser cases passed at 375px and 1280px, including actual patient creation, D01 fixed output, D08 held output and an unmapped D02 PDF with a misleading D01 filename. Expanded known cases passed real-browser WCAG A/AA checks, Inter font, 44px controls and horizontal reflow. Normal executable assets and source maps omit fixed-result values. The API application role is not superuser and has no RLS bypass. The exact owned run shut down with exit 0; its directory was removed and all five ports were free.

The extended harness first assumed the patient-creation form was open with a populated roster; it was corrected to follow the existing Add a synthetic patient control and the 40-character label contract. No timeout or product check was weakened. Native preview snapshots timed out after sign-in; the documented Playwright workflow supplied the remaining real-browser visual evidence.
