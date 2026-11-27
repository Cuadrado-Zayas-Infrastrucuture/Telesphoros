# Spec 053: Help becomes a chat, and a model answers in it (spec only)

Date: 2026-11-26

The founder asked to bring the chat back as user assistance, inside Help, with a model answering (direction plan slice A4). Spec 053 splits
it in two:
- **C1** turns the Help drawer into a conversation over the engine it has today, with no model. It can ship now.
- **C2 to C4** add a model that answers from the reviewed articles only, under a citation check written in code. It stays dormant behind a
  switch and falls back to the C1 answer. It ships only after the direction plan's gates (R1 to R5, hosting and spend).

The founder decided on 2026-11-26:
- `phi` for the typed text (HC-D1);
- English first (HC-D3);
- signed articles only (HC-D4);
- the mechanical citation rule (HC-D5);
- a help lane in spec 003 (HC-D6);
- for hosting (HC-D2), a principle rather than a vendor: the model is a replaceable plug-in behind one interface, and the corpus,
  prompt, checks, evaluation set and business logic stay ours (section 4a). The first provider is picked in C4.

Record: [spec 053](../../specs/053-help-chat/spec.md). No code, route, setting, migration or Terraform change.
