-- compat: breaking
-- Audit finding (foundation layers 3 and 12): the scheduled stored-file re-check counted a failed read as a check. file_verification_stale took the newest
-- `verified_at` over EVERY outcome, so a report whose only record was `unreadable` (the store could not be read: an outage, a timeout, a permission error) looked
-- freshly checked and was not handed out again for the whole freshness window (30 days). The job's own retry skipped it too: the first attempt recorded the report
-- unreadable and asked to be retried, and the retry, asking the same question, was not given that report.
--
-- Now only `ok`, `missing` and `changed` are checks. They say something about the file, and a finding (`missing`, `changed`) keeps its report out of the batch for the
-- window as before, because a person is already looking at it. `unreadable` says nothing about the file, so a report with no check, or only an old one, plus any number
-- of failed reads, is due. To keep a report the store keeps failing on from filling every batch, the order is now: never attempted first, then the least recently
-- ATTEMPTED (any outcome), so a report that just failed goes to the back of the line behind everything older.
--
-- One function body replaced (same signature, same owner, same grants). CREATE OR REPLACE makes this `breaking` under the migration lint: an older image still runs,
-- but would hand the same report out with the old rule until it is replaced. Nothing is deployed yet.
SET LOCAL lock_timeout = '2s';
GRANT CREATE ON SCHEMA public TO telesphoros_jobs; -- only while this migration runs (revoked at its end)
SET LOCAL ROLE telesphoros_jobs;
CREATE OR REPLACE FUNCTION file_verification_stale(p_job uuid, p_worker text, p_limit integer, p_max_age_seconds integer)
RETURNS TABLE (report_id uuid, storage_key text, object_version text, sha256 text, size_bytes bigint, content_type text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
#variable_conflict use_column
DECLARE h record;
BEGIN
  IF p_limit < 1 OR p_limit > 200 OR p_max_age_seconds < 60 THEN RAISE EXCEPTION 'Limits out of range.' USING ERRCODE = 'invalid_parameter_value'; END IF;
  SELECT * INTO h FROM public.job_held(p_job, p_worker, ARRAY['files.verify-stale']);
  RETURN QUERY
    SELECT r.id, r.storage_key, r.object_version, r.sha256, r.size_bytes, r.content_type
      FROM public.reports r
      LEFT JOIN LATERAL (
        SELECT max(v.verified_at) FILTER (WHERE v.outcome <> 'unreadable') AS checked_at,
               max(v.verified_at) AS attempted_at
          FROM public.file_verifications v WHERE v.tenant_id = r.tenant_id AND v.report_id = r.id
      ) lv ON true
     WHERE r.tenant_id = h.tenant_id AND r.uploaded_at IS NOT NULL AND r.deleted_at IS NULL AND r.object_version IS NOT NULL
       AND (lv.checked_at IS NULL OR lv.checked_at < now() - make_interval(secs => p_max_age_seconds))
     ORDER BY lv.attempted_at NULLS FIRST, r.seq
     LIMIT p_limit;
END
$$;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_jobs;
