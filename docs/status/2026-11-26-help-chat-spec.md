# Spec 053: Help becomes a chat, and a model answers in it (spec only)

Date: 2026-11-26

The founder asked to bring the chat back as user assistance, inside Help, with a model answering (direction plan slice A4). Spec 053 splits
it in two:
- **C1** turns the Help drawer into a conversation over the engine it has today, with no model. It can ship now.
- **C2 to C4** add a model that answers from the reviewed articles only, under a citation check written in code. It stays dormant behind a
  switch and falls back to the C1 answer. It ships only after the direction plan's gates (R1 to R5, hosting and spend).

Waiting on six decisions:
- the data class (HC-D1, F1);
- where the model runs (HC-D2, AG-D7);
- languages (HC-D3);
- draft articles (HC-D4);
- the citation rule (HC-D5);
- how spec 003's harness covers help (HC-D6).

Record: [spec 053](../../specs/053-help-chat/spec.md). No code, route, setting, migration or Terraform change.
