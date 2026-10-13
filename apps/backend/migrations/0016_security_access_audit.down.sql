SET LOCAL ROLE telesphoros_ledger;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.security_audit_events) THEN
    RAISE EXCEPTION 'Refusing to drop populated security audit events.';
  END IF;
END $$;
DROP FUNCTION security_audit_record(text,text,text,text,text,uuid,text);
DROP TABLE security_audit_events;
RESET ROLE;
