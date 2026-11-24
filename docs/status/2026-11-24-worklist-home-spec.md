# Spec 049: the worklist home (direction plan slice A1; specification only)

Date: 2026-11-24

A draft specification, [spec 049](../../specs/049-worklist-home/spec.md), turns the signed-in home from the chat into a worklist: quick
actions (find a patient, add a patient, attach a report), then "Follow-ups due" and "Held results", each line opening the patient page
where the work is done. Each section reads its queue's own route and fails on its own. An empty section says so in a fixed sentence, and
nothing is ranked by urgency. The other queues (duplicates, merges, disputes, wrong-patient links) have no screen in the clinical app yet,
so the spec leaves them off the home. It is in two slices: W1, a `disposition` filter on `GET /evaluations`; W2, the frontend. Five
decisions, W-D1 to W-D5, wait on the founder. No code, route, setting, migration or knowledge change.
