import { z } from 'zod';

/**
 * Coarse roles for Phase 2. `reader` can only read; `clinician` can also create/change;
 * `admin` is reserved for future administration. Phase 4 maps real identity-provider roles onto these.
 */
export const ROLES = ['reader', 'clinician', 'admin'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;
