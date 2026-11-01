import { z } from 'zod';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

/** Query-string pagination. Values arrive as strings, so they are coerced. */
export const paginationQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/**
 * Optional on the lists that offer it (`GET /patients`, `GET /reports`): oldest first is the default and stays the contract for every caller that does not ask,
 * `desc` reads the same index backwards, so a page still stops early. Any other word is refused, never guessed.
 */
export const listOrderSchema = z.enum(['asc', 'desc']).default('asc');
export type ListOrder = z.infer<typeof listOrderSchema>;

export const paginationMetaSchema = z.strictObject({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  total: z.number().int().min(0),
  totalPages: z.number().int().min(0),
});
export type PaginationMeta = z.infer<typeof paginationMetaSchema>;

/** Standard list envelope: `{ data, meta }`. */
export function paginatedSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({ data: z.array(item), meta: paginationMetaSchema });
}
export type Paginated<T> = { data: T[]; meta: PaginationMeta };

export function buildMeta(page: number, pageSize: number, total: number): PaginationMeta {
  return { page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}
