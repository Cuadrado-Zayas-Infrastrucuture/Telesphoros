-- Removes the two functions 0031 added. Nothing else changes; 0028's six-argument function, grants and tables are untouched.
SET LOCAL ROLE telesphoros_capability;
DROP FUNCTION app_capability_version();
DROP FUNCTION tenant_capability_issue_current(text, text, text, bytea, text);
RESET ROLE;
