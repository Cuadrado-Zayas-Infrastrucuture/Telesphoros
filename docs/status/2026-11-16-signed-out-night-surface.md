# The sign-in flow wears the public landing's night look

Date: 2026-11-16

The three pages a signed-out person passes through (`/signin`, `/auth/callback`, `/signed-out`) are shown on a dark teal "night"
surface whatever the theme preference, so the step from the public landing to signing in does not change colour (founder decision;
spec 009, Amendment 1). The surface is sixteen colour tokens on top of the dark theme, pinned and contrast-checked by the branding
guard like the light and dark values. The sign-in page also shows a decorative drawing made in code, a sphere of characters that
settles within five seconds; no image or video file is loaded and it holds no data. No word on those pages changes, sign-in works as
before, and no signed-in page, route, role or stored data changes.
