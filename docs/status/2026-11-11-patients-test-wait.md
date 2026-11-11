# The Patients page test waits for its list
Date: 2026-11-11

One Patients page test looked for the patient list once, right after the section appeared, while the page could still be loading. On a slow runner it failed. It now waits for the list, as the other tests in the file do. With the patients response delayed by 300 ms, the old line fails with the same error CI showed and the new line passes.

Test change only; the page is unchanged.
