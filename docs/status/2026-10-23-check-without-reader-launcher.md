# Chore: the without-engine check also runs the launcher-cors test (local)

Date: 2026-10-23

#273 made the report-reader engine optional and added `scripts/check-without-reader.sh`, which renamed the engine directories away and ran the backend Jest suite. Its first push still broke the browser job: `test:launcher-cors` loads the review launcher (`scripts/local-review/start.cjs`) outside Jest, through its own module loader, and a relative `require` I had added there failed. The script could not have caught it, because it only ran Jest.

Now the default mode also runs `pnpm test:launcher-cors` with the engine renamed away. It needs a Python with the pinned Moto (`LOCAL_MOTO_PYTHON`); without one it prints `NOT RUN: test:launcher-cors ...` and does not claim to have covered the lane.

Verified: passes with the engine removed (backend suite 1582 passed, launcher-cors 5 of 5); with the first push's `require` put back into `start.cjs` the script exits 1 on launcher-cors tests 3 and 4 (`Cannot find module './require-reader.cjs'`), so the new lane can go red; with no Moto it announces the skip. Not changed: the measure mode (Jest only), CI workflows, the launcher.

Local only until the pull request is opened.
