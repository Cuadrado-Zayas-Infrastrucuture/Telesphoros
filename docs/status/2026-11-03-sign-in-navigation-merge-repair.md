# Sign-in branch browser navigation merge repair
Date: 2026-11-03

PR #265's merge of main duplicated the upload-recovery helper's navigation
sequence. The second sequence expected the restored dialog to be absent.
Reproduced the exact failure locally before restoring the single sequence
from main. The complete upload-navigation test file now matches main.

This repair removes only the duplicate sequence. Original recovery keys,
retry, cancellation and request-identity assertions remain. No production
code, test deadlines, retries, skips or arbitrary sleeps change. Verification
results and exact-head hosted checks are recorded in the PR.
