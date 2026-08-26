/**
 * Atomic per-form-and-year allocation. This statement must not use COUNT(*) + 1.
 */
export const ALLOCATE_ACT_SEQUENCE_SQL = `
INSERT INTO act_number_sequences ("formCode", year, "lastIssued")
VALUES (CAST($1 AS "ActFormCode"), $2, 1)
ON CONFLICT ("formCode", year)
DO UPDATE SET "lastIssued" = act_number_sequences."lastIssued" + 1
RETURNING "lastIssued"
`.trim();
