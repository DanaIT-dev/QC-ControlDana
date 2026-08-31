-- Prisma INSERT ... RETURNING requires SELECT. Runtime SELECT on audit_logs is
-- restricted so AUTH cannot read business history and WORKER cannot read
-- operator journals.

SET ROLE sgr_owner;

GRANT SELECT ON audit_logs TO sgr_auth, sgr_worker;

CREATE POLICY audit_select_auth ON audit_logs FOR SELECT TO sgr_auth
  USING (
    "entityType" IN ('USER', 'SESSION')
    AND action IN (
      'LOGIN_SUCCEEDED',
      'LOGIN_FAILED',
      'LOGIN_RATE_LIMITED',
      'LOGOUT',
      'LOGOUT_ALL',
      'SESSION_REJECTED_ARCHIVED_USER',
      'SESSION_REJECTED_VERSION_MISMATCH',
      'USER_PASSWORD_CHANGED'
    )
  );

CREATE POLICY audit_select_worker ON audit_logs FOR SELECT TO sgr_worker
  USING (
    sgr_ctx_is_worker()
    AND action IN (
      'OUTBOX_DEAD',
      'EMAIL_DELIVERY_EXHAUSTED',
      'SLA_EVALUATION_COMPLETED',
      'SLA_EVALUATION_FAILED',
      'NOTIFICATION_RECIPIENT_REVOKED',
      'ATTACHMENT_SCAN_PASSED',
      'ATTACHMENT_REJECTED',
      'ATTACHMENT_SCAN_FAILED'
    )
  );

REVOKE UPDATE ON users FROM sgr_auth;
GRANT UPDATE (
  "lastLoginAt",
  "passwordHash",
  "passwordChangedAt",
  "mustChangePassword",
  "sessionVersion",
  version,
  "updatedAt"
) ON users TO sgr_auth;

RESET ROLE;
