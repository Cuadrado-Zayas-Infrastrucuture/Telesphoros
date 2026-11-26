# Spec 053 slice C1: plan for the Help drawer as a conversation

Date: 2026-11-26

[The plan](../../specs/053-help-chat/plan-slice-c1.md) turns the Help drawer into a conversation over the engine Help has today: the person
asks, presses Enter, and Help answers with the best article quoted whole, the refusal for a question about a patient, or the closest three.
No model, route or setting; frontend only. Nothing typed is sent or stored, and the conversation is cleared when the drawer closes.

The founder decided on 2026-11-26, as recommended: a suggestion button adds that article's answer to the conversation (C1-D1), and the
last 20 exchanges are kept (C1-D2). Plan only: no code or test change.
