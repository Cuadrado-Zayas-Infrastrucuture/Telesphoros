import type { PaginationMeta } from '@telesphoros/shared-types';

const PAGE_SIZE = 20;

/** Pagination meta shown before the first page has loaded. */
export const EMPTY_PAGE_META: PaginationMeta = { page: 1, pageSize: PAGE_SIZE, total: 0, totalPages: 0 };
