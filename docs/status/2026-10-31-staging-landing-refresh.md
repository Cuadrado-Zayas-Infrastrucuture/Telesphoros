# The signed-out landing describes the prototype as it is

Date: 2026-10-31

**Implemented.** The page at `/` for a signed-out visitor still described the product as it was on 2026-10-16: a storage walkthrough of the
Reports pages, PDF examples, choosing only an existing patient, and an assistant that existed only in a local demonstration. Staging now signs
people into the chat home (specs/024), lets a writer add a patient from the panel (024 D2a) and refuses PDF outside the local preview (024 D4).

- The hero leads with PGx report interpretation, as the public site does since 2026-10-30, and calls the product a prototype.
- The interactive "Add a report. Know what's stored." walkthrough is removed (founder decision 2026-10-31), with its component, its stylesheet and
  its four preview images. The header links are now Features and FAQ.
- The example files in the hero card and the capability rows are JSON. Row 01 mentions adding a patient from the panel; row 02 drops the download
  sentence (download is owned-storage only); row 03 describes the chat and shows the note it really shows, "Interpretation is not available in the
  prototype yet."
- Signed in, the hero's action opens the signed-in home (`signedInHome`), not `/reports/upload`. The closing section no longer repeats the sign-in
  button: it appears once in the header and once in the hero.
- The browser tab and description no longer say "Telesphoros Remastered" or "CPIC-guided decision support"; every page title ends in "· Telesphoros".

The Spanish text is updated in step and is still a draft that needs a Spanish-speaking reviewer. No backend, signed-in page, public site, token,
artwork or deployment change; publishing to staging is a separate step that needs the founder's OK.
