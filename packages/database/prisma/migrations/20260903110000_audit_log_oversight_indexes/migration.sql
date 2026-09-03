-- Indexes for global AuditLog filters used by oversight read queries.
SET ROLE sgr_owner;

CREATE INDEX IF NOT EXISTS "audit_logs_actorUserId_occurredAt_idx"
  ON public.audit_logs ("actorUserId", "occurredAt");

CREATE INDEX IF NOT EXISTS "audit_logs_action_occurredAt_idx"
  ON public.audit_logs (action, "occurredAt");
