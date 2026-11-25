# Plan: the walkthroughs describe the app without the chat

Date: 2026-11-25

Plan only. After the chat was retired (spec 052), `docs/start-here.md`'s walkthrough and `docs/investor-demo.md`'s local demo still send
a person to the chat. The plan rewrites their steps to the current screens (Attach a report, Reports, Follow-ups), following the order
`product-demo-e2e/fixture-flow.spec.ts` drives in CI. The founder decided both as recommended: only the two spoken lines that name the chat change (WT-D1),
and the chat-first backup recording is marked historical, with a new recording added to the pre-meeting checks (WT-D2).

Record: [the plan](../design/plans/walkthroughs-after-the-chat.md). No code, test, route or document other than the plan changes.
