-- Analytics scans re-check act visibility for every defect. A covering act
-- index lets that lookup stay index-only, and the defect index covers the
-- columns the overview, backlog, and ranking aggregates read.
CREATE INDEX acts_id_object_covering_idx
  ON public.acts (id) INCLUDE ("objectId");

CREATE INDEX defect_items_analytics_cover_idx
  ON public.defect_items ("createdAt", status)
  INCLUDE ("actId", "readyAt", "effectiveDeadline", "defectTypeId", "workTypeId");
