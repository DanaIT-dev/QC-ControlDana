-- A defect keeps the latest submission and the latest rejection on one row.
-- After a return to work, the next submission is later than that rejection.
-- Each cycle is still ordered on defect_inspection_attempts (reviewedAt >= submittedAt).
-- rejectedAt >= createdAt stays.

ALTER TABLE public.defect_items
  DROP CONSTRAINT defect_items_rejected_not_before_submission;
