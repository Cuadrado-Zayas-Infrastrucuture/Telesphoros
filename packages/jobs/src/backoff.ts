/**
 * Seconds to wait before attempt `attempt + 1` after attempt number `attempt` (1-based) failed: 60, 300, 1500, ... capped at an hour, with +-20% jitter.
 * The database computes the same thing in `job_fail` (migration 0023); a test keeps the two in agreement.
 */
export function retryDelaySeconds(attempt: number, random: number = Math.random()): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('attempt is a positive integer');
  return Math.min(3600, 60 * 5 ** (attempt - 1)) * (0.8 + 0.4 * random);
}
