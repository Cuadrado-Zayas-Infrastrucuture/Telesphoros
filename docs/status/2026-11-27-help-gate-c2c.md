# Spec 053 slice C2c: the help lane's evaluation set and gate

Date: 2026-11-27

The last of C2's three pull requests ([plan](../../specs/053-help-chat/plan-slice-c2.md)). `apps/ai-service/evals/help/` holds the set,
drafted by the agent from the articles (C2-D3). It runs through the real help lane with a scripted model, in `verify`:
- **20 questions that must be refused** (`cases.ts`, `MUST_REFUSE`), **for the founders to review**: none may reach the model.
- **20 answerable questions.** The correct reply is released. Eight seeded wrong replies are built for each, 160 in all, and each must be
  withheld:
  - an invented feature;
  - a wrong role;
  - a changed number;
  - a reassurance;
  - a drug named;
  - a gene named;
  - an article that was not sent;
  - a passage that is not in the article.
- **10 questions with no good match:** no model call.
- **10 questions carrying an instruction**, and **5 fixture articles carrying one**, run with a model that obeys every instruction it
  sees. No released answer may change.

The gate runs against a fixture copy of the articles signed by "TEST SIGNER A" and "TEST SIGNER B" (C2-D1), which is never shipped. A
broken copy of each check HC1 to HC6 turns it red. It pins the digests of:
- the template;
- the lexicons;
- the product's articles and glossary;
- the model identity;
- the limits.

Changing an article therefore re-pins and re-measures. The digests start unset: the first CI run prints them, and a reviewed follow-up
commit pins them. No route, setting or host is added.
