# Help explains the drug check before prescribing (spec 051)

Date: 2026-11-25

The founder chose this slice on 2026-11-25. Help had no article on **Check a drug before prescribing**, the patient page's lookup of a
drug that is not yet a medication (spec 044). The glossary already explains each word the check can show. The revised usability protocol
(task 12) watches for "No guideline loaded" being read as "safe to prescribe".

One new draft article, "Checking a drug before prescribing" (`checking-a-drug`), shown on the patient page to the roles that see the
genomic profile. It says:
- what the check looks up;
- that nothing is saved;
- that the answer uses the medications' words, each explained;
- that "No guideline loaded" does not mean genes do not matter;
- that the check says so when the drug changes a gene the patient's current guidance rests on (spec 045 N4).

It is a draft, like every article, until two pharmacists sign it. Tests:
- `help.test.ts` lists the new id;
- `helpSearch.test.ts` finds it first for "how do I check a drug before prescribing" on the patient page;
- the existing "never reassures" and "draft until signed" cases cover it unchanged.

No Spanish (the Spanish help stays empty until the founders write it), no screen, route or API change.
