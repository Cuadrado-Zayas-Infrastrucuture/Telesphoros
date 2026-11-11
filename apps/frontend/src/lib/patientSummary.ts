import type { PatientDto } from '@telesphoros/shared-types';
import { SEX_LABELS } from './demographicsDraft';

/**
 * "Female · born 1970": what tells two patient codes apart on a list or in a picker, from the coded fields a list
 * already carries. Never an identity value: lists do not decrypt (spec 025), so no name or date of birth is
 * available there. The year-based age is left out on purpose: it can be one year high until the birthday.
 * Empty when neither field is recorded.
 */
export function patientSummary(patient: Pick<PatientDto, 'sex' | 'birthYear'>): string {
  return [patient.sex ? SEX_LABELS[patient.sex] : null, patient.birthYear ? `born ${patient.birthYear}` : null].filter(Boolean).join(' · ');
}

/**
 * Whole years from a full date of birth (YYYY-MM-DD) to `today`, by the calendar: exact, unlike the list's
 * year-based age. null when the date is unusable or in the future.
 */
export function exactAge(dateOfBirth: string, today: Date = new Date()): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const hadBirthday = today.getMonth() + 1 > month || (today.getMonth() + 1 === month && today.getDate() >= day);
  const age = today.getFullYear() - year - (hadBirthday ? 0 : 1);
  return age >= 0 ? age : null;
}
