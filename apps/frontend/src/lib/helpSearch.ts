// Spec 053 slice C2a: Help's search and its patient-question rule live in packages/help-content (src/engine/search.ts), so the browser and
// the help lane on the server share one rule. This file keeps the frontend's imports unchanged.
export { articlesFor, helpScreenOf, isPatientQuestion, normalizeHelpText, queryWords, searchHelp, visibleTo, type HelpHit, type HelpResults } from '@telesphoros/help-content';
