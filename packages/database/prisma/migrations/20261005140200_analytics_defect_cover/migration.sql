-- Overview, backlog, and ranking read these defect columns for every open row.
-- Keeping them in the act index lets staff scans avoid a heap fetch per defect.
CREATE INDEX defect_items_act_analytics_idx
  ON public.defect_items ("actId", "createdAt")
  INCLUDE (
    id,
    status,
    "updatedAt",
    "readyAt",
    "effectiveDeadline",
    "defectTypeId",
    "workTypeId",
    location,
    "submittedForInspectionAt",
    "acceptedAt",
    "rejectedAt"
  );
