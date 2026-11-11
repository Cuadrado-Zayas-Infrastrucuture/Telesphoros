# A privacy policy draft, for counsel

Date: 2026-11-11

The security checklist review (2026-11-11) found no privacy policy. The founder asked for a draft that says plainly that there is no real data
and there are no real users. [The draft](../legal/privacy-policy-draft.md) does that: pre-release, not approved for clinical use, synthetic
records only, invited testers only, no business associate agreement. It lists what is collected about testers (sign-in email, authenticator
registration, role and organization, sign-in and request records without their contents), what the browser keeps (session storage while
signing in, preferences only with consent, an upload-resume record for at most an hour), the hosting provider and region, retention, and
rights, each traced to the file that does it.

It is **not reviewed by counsel, not approved and not published**: nothing links to it, and `apps/frontend/src/lib/helpLinks.ts` still names no
privacy policy. Placeholders in [square brackets] are for the company: legal name, contact address, effective date, the retention period after
an account closes, and the rights that apply where testers are. The company website is a separate repository and is not covered.
