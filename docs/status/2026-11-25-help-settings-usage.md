# Help explains the Settings and Usage pages (spec 051)

Date: 2026-11-25

The founder chose this on 2026-11-25. Settings and Usage were the only Help screens with no article of their own. Two new draft articles,
each written from the page's own words:

- **"Your settings"** (`your-settings`, everyone, on Settings). It covers:
  - who is signed in, the organization, and what each role allows (described, never enforced, by the list);
  - the preferred name and where it shows;
  - appearance and browser storage, and that the sign-in is held in the tab only;
  - what Sign out ends;
  - for administrators, Access review: by patient id or member, at most 92 days, a file to download, ids not names.
- **"What the usage page counts"** (`the-usage-page`, administrators only, on Usage). It covers:
  - this month and last month: reports uploaded, evaluations with results, evaluations held;
  - the report files kept and their size;
  - the upload calendar, in Puerto Rico time;
  - that the figures count activity, not whether a result was right or how a patient did.

Both are drafts until two pharmacists sign them.

Tests:
- `help.test.ts` lists both ids;
- `helpSearch.test.ts` finds each first for its question, and keeps the Usage article from a reader;
- the existing check that "an administrator sees nothing clinical" now allows an article for administrators alone, as well as articles
  for everyone. Its intent is unchanged, and it now also asserts that the Usage article is there.

No Spanish, screen, route or API change.
