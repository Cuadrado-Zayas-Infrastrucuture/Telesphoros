import { z } from 'zod';

/**
 * Coarse roles. `reader` can only read; `clinician` can also create/change; `admin` is ADMINISTRATION ONLY (M2.1a): it manages the people of its
 * own organization and reads no clinical data, so a person who needs both holds both. `reviewer` is the one role that may accept or reject a text
 * capture of a lab report (slice 5B-3.2); it adds to whatever else a person holds and is never implied by another role (an `admin` alone cannot
 * accept). A person may hold several roles at once.
 */
export const ROLES = ['reader', 'clinician', 'admin', 'reviewer'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;
