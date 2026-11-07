# One sign-in action on the sign-in page

Date: 2026-11-01

The public header omits its signed-out Sign in link while the sign-in route is open. The page's primary Sign in button still starts authentication and preserves the requested destination. The header continues to offer Sign in on other public pages and Open workspace to signed-in users.

The route match includes query strings and trailing slashes. Public-route accessibility checks cover those forms; the browser authentication suite checks the absence of the redundant header link on mobile and desktop. Authentication, permissions, branding and deployment configuration are unchanged. This source change does not publish the frontend to staging.
