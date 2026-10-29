# Feature Specification: Usage (USE)

**Feature Branch**: `feat/usage-api` (the backend half; the page follows in a second PR)

**Created**: 2026-10-28

**Status**: Approved 2026-10-28. The founder asked for a Usage panel and, asked to choose, accepted the recommendation: organization activity and storage, admin only, backend first. Billing stays deferred. Months are in Puerto Rico time; that was the stated default, and the go-ahead accepted it.

**Input**: An organization's administrator could not see how much the organization uses the service. Billing will later need the same numbers.

## Decisions

- **D1, route:** `GET /api/v1/usage`, for `admin` only, for the caller's own organization. It takes no organization argument.
- **D2, months:** calendar months in Puerto Rico time (`America/Puerto_Rico`, UTC−4 all year, no daylight saving). The answer covers this month so far and last month.
- **D3, reports uploaded:** reports whose upload completed in the month (`uploaded_at`), including reports deleted since: the upload still happened.
- **D4, evaluations:** evaluation records created in the month, split into `evaluated` (results shown) and `held`.
- **D5, storage:** report files whose upload completed and that are not deleted: how many, and the sum of their recorded sizes. It is computed from the records, not the bucket, so it leaves out retained old versions and deleted objects that are still in their retention period.
- **D6, counts only:** no patient, report, person or file names, and no ids. Nothing clinical, which fits the `admin` role.

## Out of scope

- Billing, quotas and limits.
- A breakdown per person.
- The frontend page (second PR).

## User Scenarios & Testing

1. **An administrator checks usage (P1).** **Acceptance:** the counts match what the organization did in each month, and its storage.
2. **Another organization's activity (P1).** **Acceptance:** it never appears in the counts.
3. **A non-administrator (P1).** **Acceptance:** a reader, clinician, reviewer or member with no role gets 403; an anonymous request gets 401.
4. **Month edges (P2).** **Acceptance:** 03:59 UTC on the 1st is still the previous month in Puerto Rico, and 04:00 UTC is the new one. January's last month is the previous December.

## Requirements

- **USE-1** Every query is parameterized and filtered by the caller's tenant id, and on PostgreSQL it runs through the application role under row-level security.
- **USE-2** The response is parsed against `usageDtoSchema` in shared-types.
- **USE-3** The response is `Cache-Control: private, no-store`, like every authenticated response.
