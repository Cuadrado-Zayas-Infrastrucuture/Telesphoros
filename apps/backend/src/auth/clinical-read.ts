/**
 * Who may read an organization's clinical metadata (patients, reports, recommendations, captures, evaluations, disputes).
 * A member who holds NO role may sign in and call `/me`, and nothing else (finding I04, decision DA-1): belonging to an organization is
 * not permission to read its records. Any role qualifies, `reviewer` included, because reviewers already open captures and evaluations
 * on their own (CAN_CAPTURE and CAN_EVALUATE) and the reader persona sees the same lists.
 */
export const CLINICAL_READ_ROLES = ['reader', 'clinician', 'admin', 'reviewer'] as const;
