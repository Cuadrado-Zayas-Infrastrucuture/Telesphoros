# Retiring the chat: the specification (spec 052)

Date: 2026-11-25

A specification, `specs/052-retire-the-chat/spec.md`, for the follow-up spec 051 H-D5 named. Help (spec 051) now answers how-to questions,
and attaching a report already has its own guided page, `/reports/upload`, which also recovers an interrupted upload. The chat is left as
a second way to attach and a box that refuses every question.

Two slices. RC1a: the upload page and Settings become pages, and every "Attach" link goes to the upload page. RC1b: the sidebar loses
Chat; `/chat` sends people home; the chat's code and its tests are removed, each removed case named, and every other browser suite that attached through the chat attaches through the upload page. The founder approved RC-D1 to RC-D5 as
recommended on 2026-11-25. No code change.
