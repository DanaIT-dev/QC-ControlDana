-- These covers were not selected. The smaller act index remains the scan,
-- and the extra indexes only slowed writes.
DROP INDEX IF EXISTS public.defect_items_analytics_cover_idx;
DROP INDEX IF EXISTS public.defect_items_act_analytics_idx;
