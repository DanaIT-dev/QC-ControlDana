-- Forward-only checks for timestamps stored on the same row.
-- NOT VALID leaves existing rows untouched. New inserts and updates are checked.
-- Equality is allowed. A missing timestamp stays allowed.

ALTER TABLE public.defect_items
  ADD CONSTRAINT defect_items_ready_not_before_created
  CHECK ("readyAt" IS NULL OR "readyAt" >= "createdAt") NOT VALID;

ALTER TABLE public.defect_items
  ADD CONSTRAINT defect_items_submission_not_before_created
  CHECK ("submittedForInspectionAt" IS NULL OR "submittedForInspectionAt" >= "createdAt") NOT VALID;

ALTER TABLE public.defect_items
  ADD CONSTRAINT defect_items_accepted_not_before_created
  CHECK ("acceptedAt" IS NULL OR "acceptedAt" >= "createdAt") NOT VALID;

ALTER TABLE public.defect_items
  ADD CONSTRAINT defect_items_accepted_not_before_submission
  CHECK (
    "acceptedAt" IS NULL
    OR "submittedForInspectionAt" IS NULL
    OR "acceptedAt" >= "submittedForInspectionAt"
  ) NOT VALID;

ALTER TABLE public.defect_items
  ADD CONSTRAINT defect_items_rejected_not_before_created
  CHECK ("rejectedAt" IS NULL OR "rejectedAt" >= "createdAt") NOT VALID;

ALTER TABLE public.defect_items
  ADD CONSTRAINT defect_items_rejected_not_before_submission
  CHECK (
    "rejectedAt" IS NULL
    OR "submittedForInspectionAt" IS NULL
    OR "rejectedAt" >= "submittedForInspectionAt"
  ) NOT VALID;

ALTER TABLE public.defect_inspection_attempts
  ADD CONSTRAINT defect_inspection_attempts_review_not_before_submit
  CHECK ("reviewedAt" IS NULL OR "reviewedAt" >= "submittedAt") NOT VALID;

ALTER TABLE public.acts
  ADD CONSTRAINT acts_started_not_before_created
  CHECK ("startedAt" IS NULL OR "startedAt" >= "createdAt") NOT VALID;

ALTER TABLE public.acts
  ADD CONSTRAINT acts_cancelled_not_before_created
  CHECK ("cancelledAt" IS NULL OR "cancelledAt" >= "createdAt") NOT VALID;

ALTER TABLE public.import_batches
  ADD CONSTRAINT import_batches_completed_not_before_started
  CHECK ("completedAt" IS NULL OR "completedAt" >= "startedAt") NOT VALID;
