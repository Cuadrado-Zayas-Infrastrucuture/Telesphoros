-- Puts back the 0024 body: every outcome, `unreadable` included, counts as a check. Changes no data.
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
      LEFT JOIN LATERAL (SELECT max(v.verified_at) AS last_at FROM public.file_verifications v WHERE v.tenant_id = r.tenant_id AND v.report_id = r.id) lv ON true
     WHERE r.tenant_id = h.tenant_id AND r.uploaded_at IS NOT NULL AND r.deleted_at IS NULL AND r.object_version IS NOT NULL
       AND (lv.last_at IS NULL OR lv.last_at < now() - make_interval(secs => p_max_age_seconds))
     ORDER BY lv.last_at NULLS FIRST, r.seq
     LIMIT p_limit;
END
$$;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM telesphoros_jobs;
