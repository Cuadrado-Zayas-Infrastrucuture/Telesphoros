# The unavailable-value matcher checks NFC, not a Unicode version
Date: 2026-11-10

The lab-report matcher used to refuse any runtime that did not report Unicode 16.0, which held Node at 22.22.0. It takes only NFC from the runtime, so it now checks that NFC at load, across every code point, and refuses to load if anything that can reach one of its seven tokens behaves differently from the verified list. The tokens and the comparison steps are unchanged. Every workflow now takes its Node from `NODE_VERSION`, and the pin guard reads them all. Node itself does not move in this change.

Verification results are recorded in the pull request. Synthetic data only; no deployment or clinical-use approval.
