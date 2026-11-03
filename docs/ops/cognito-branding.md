# Cognito sign-in branding

The existing authentication source uses the Cognito hosted authorization-code/PKCE flow. Its domain does not explicitly select a managed-login version; the deployed branding version and feature plan have **not** been inspected. Confirm those live settings before choosing a branding API. This change prepares **classic hosted UI (version 1)** styling only and does not migrate the domain or select a paid feature plan.

The generated CSS carries over the app's light palette, slate text, teal primary/hover/focus, control borders, error/success colors and 48px input/button targets. It uses the unchanged approved product shield/Rx PNG (34,133 bytes). AWS retains its own layout, font, text, button shape and authentication/challenge behavior. Classic CSS cannot load the app's Inter/Poppins fonts or implement its responsive layouts/dark theme. The local preview is explicitly illustrative and is not a deployed Cognito capture.

## Review assets

- `infrastructure/terraform/cognito/hosted-ui.css`: generated, AWS-template classes/properties only, under 3KB.
- `scripts/cognito/classic-branding.mjs`: resolves values from canonical app tokens because Cognito cannot use application CSS variables/imports. Run `node scripts/cognito/classic-branding.mjs --write` after approved token changes; `--check` and the infrastructure guards reject drift.
- The image is referenced directly from `apps/frontend/src/assets/telesphoros-shield-rx.png`; no copy, resampling or recoloring.
- Serve the repository locally and visit `docs/design/cognito/preview.html`. It has no submit action or auth code; do not enter actual credentials.

## Live review and activation

Nothing changes in AWS by merging this PR. `enable_cognito_classic_branding` defaults to false. When enabled, the Terraform resource targets only the existing SPA client, not pool-wide `ALL`. Its precondition requires `cognito_branding_observed_login_version=1` from an approved read-only domain inspection and a version-1 domain plan. That supplied observation is a human review gate, not an automatic live-domain lookup; the provider supplies a planned classic-version default even in mocked plans. Missing observations and observed version 2 are refused. The domain, pool, client, callback/logout URLs, scopes, MFA, invite-only access and token handling remain unchanged.

1. Follow the existing authorized-account and saved-plan procedures in [Terraform state](terraform-state.md), [frontend publishing](frontend-publish.md) and the infrastructure README. Live deployment requires its existing approval gates; this document grants none.
2. Inspect `DescribeUserPoolDomain.ManagedLoginVersion`, the current feature plan and the exact browser client. If version 2 is active, stop: use managed-login branding instead of downgrading the domain. Changing login versions can end existing login sessions.
3. Export `GetUICustomization` for that client and retain the previous CSS and logo privately for rollback. Confirm whether an existing customization needs importing (`USER_POOL_ID,CLIENT_ID`) before Terraform manages it. A new SetUICustomization can otherwise overwrite existing client branding.
4. Review an actual saved Terraform plan with `enable_cognito_classic_branding=true` and `cognito_branding_observed_login_version=1` only after the live inspection in step 2. The intended change is the SPA customization only; stop if it alters any authentication setting or unrelated infrastructure. The local mocked plans verify configuration behavior, not AWS CSS acceptance or live account settings.
5. Apply only the separately approved saved plan. This task does not apply it. AWS reports classic branding can take up to a minute to appear.
6. Verify in a fresh browser: password sign-in, invite/temporary-password reset, required authenticator setup, MFA challenge, invalid credentials, forgotten-password recovery, sign-out and return to the workspace. Check mobile, keyboard focus, reflow and contrast on the actual AWS screens. Validate the submitted focus-outline value against AWS; no live CSS acceptance is claimed here.

For rollback, restore the previously exported client CSS/logo and reconcile Terraform state/configuration. Disabling the flag removes this managed client customization and inherits pool defaults; it does not reconstruct an earlier client override. Provider image drift detection is limited, so also visually inspect the live logo after applying.

## Sources

- [AWS classic branding limits and supported properties](https://docs.aws.amazon.com/cognito/latest/developerguide/hosted-ui-classic-branding.html)
- [SetUICustomization API and CSS template](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_SetUICustomization.html)
- [Terraform UI customization resource](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cognito_user_pool_ui_customization)
- [AWS managed-login branding and version selection](https://docs.aws.amazon.com/cognito/latest/developerguide/managed-login-branding.html)
