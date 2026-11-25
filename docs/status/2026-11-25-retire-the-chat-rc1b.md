# Retiring the chat, RC1b: the chat is gone (spec 052)

Date: 2026-11-25

The second of the two slices in `specs/052-retire-the-chat/spec.md` (RC-D1 to RC-D5 approved as recommended on 2026-11-25), after RC1a (#479).

- **No chat:** no Chat in the sidebar for any role (RC-6), and no box for typed questions outside Help (RC-1).
- **`/chat` sends the person home** (RC-5, RC-D2), so an old link or bookmark never shows an error.
- **The chat's code is removed** (RC-D5), with its own tests. Every removed case is named in the
  [verification record](../verification/2026-11-25-retire-the-chat-rc1b.md), with the test that proves the same rule elsewhere.
- **Every browser suite that attached through the chat attaches on Attach a report.**
- Help no longer has a `chat` screen; the shell's word `chat` is gone, so the founders' Spanish list (LS2b) is one word shorter.

Open: the slice's breakages (with the other open defect injections), and the public landing page, which still describes the chat home in
English and in the founders' draft Spanish. No backend, API, migration or Terraform change.
