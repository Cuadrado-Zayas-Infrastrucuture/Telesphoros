# Cognito classic branding preview

Open `preview.html` through a local server rooted at the repository. `mobile.png` (390px) and `desktop.png` (1440px, with example error expanded) are illustrative component captures. The preview explicitly labels its limitations, uses synthetic read-only fields and disables sign-in. It is not an AWS screenshot and must not be deployed as an authentication page.

Only the generated `infrastructure/terraform/cognito/hosted-ui.css` and the unchanged approved product PNG are intended for Cognito. Preview HTML/layout CSS stay local documentation. AWS controls the real layout, system font, copy, challenges and button shapes; the exact Inter/Poppins application screen is not promised.

Chromium review: 320/390/1440px without horizontal overflow, 48px inputs/buttons, visible teal focus outline, zero axe violations with the example error expanded, zero external network requests. See `docs/ops/cognito-branding.md` for verification, activation and rollback boundaries.
