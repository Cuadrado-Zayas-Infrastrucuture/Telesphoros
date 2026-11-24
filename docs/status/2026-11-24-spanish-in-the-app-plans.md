# Spanish in the signed-in app: the identity-wording plan and spec 050

Date: 2026-11-24

**The identity-wording plan**, `docs/design/plans/patient-identity-spanish.md`, covers the Spanish of the five strings the patient page
shows when the identity cannot be read (#454). The founder approved S-D1 to S-D3 as recommended on 2026-11-24:

- the two pharmacist founders write and sign the Spanish;
- it is recorded beside the English and tested, but not shown, until the app has a language choice;
- that choice gets its own spec.

**Spec 050, `specs/050-workspace-spanish/spec.md`, is that spec. Not approved yet.** It covers:

- a language choice for the signed-in app, English by default and never the browser's language;
- one table of words per screen, with English and Spanish side by side;
- whole screens translated, never a mix;
- two pharmacists' signatures on every clinical string;
- nothing machine translated;
- the order of slices LS1 to LS6.

It also lists the Spanish that specs 038, 044, 045 and 049 have left waiting. Eight decisions, LS-D1 to LS-D8, are put to the founder.

Neither document contains Spanish text. No code change.
