# Spec 003 amendment: the help lane (spec 053 HC-D6)

Date: 2026-11-26

[The amendment](../../specs/003-llm-harness/help-lane.md) adds a second task to the model harness: Help's answers (spec 053 C2 to C4). It
reuses the clinical lane's model port, budgets, switch, trace and receipt, and evaluation gate, and none of its clinical evidence rules:
- the model is asked only when the curated engine has already found signed articles that answer the question, and never for a refused
  question;
- every sentence must cite a passage of a signed article that carries its meaning-carrying words (HC1 to HC6, in code);
- a failed check shows the curated answer;
- nothing typed or answered is stored, not even a digest;
- the evaluation set (questions that must be refused, answerable questions with seeded wrong answers, and injected instructions in
  questions and articles) runs in `verify` whenever the help lane or the articles change.

Open for the founder: HL-D1 (what a failed check does), HL-D2 (counsel before real use) and HL-D3 (the model's own refusal check). Spec
only: no code, route, setting, migration or Terraform change.
