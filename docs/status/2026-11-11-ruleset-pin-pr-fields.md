# The ruleset file names every live pull-request setting
Date: 2026-11-11

`.github/rulesets/main.json` now names the merge methods, required reviewers and dismissal restriction that the live ruleset already has, so importing the file through the API cannot reset them to GitHub's defaults. The same day the file's CodeQL rule was applied to the live ruleset, which now matches this file exactly.

Configuration record only; the live ruleset is unchanged by this change.
