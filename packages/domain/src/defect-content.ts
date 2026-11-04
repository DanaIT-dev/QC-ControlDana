export interface DefectContentFields {
  location: string | null;
  defectTypeId: string | null;
  workTypeId: string | null;
  claimDetails: string | null;
  notes: string | null;
}

export interface DefectContentPatch {
  location?: string | null;
  defectTypeId?: string | null;
  workTypeId?: string | null;
  claimDetails?: string | null;
  notes?: string | null;
}

export function applyDefectContentPatch(
  current: DefectContentFields,
  patch: DefectContentPatch,
): { next: DefectContentFields; changed: boolean } {
  const next: DefectContentFields = {
    location: patch.location === undefined ? current.location : patch.location,
    defectTypeId: patch.defectTypeId === undefined ? current.defectTypeId : patch.defectTypeId,
    workTypeId: patch.workTypeId === undefined ? current.workTypeId : patch.workTypeId,
    claimDetails: patch.claimDetails === undefined ? current.claimDetails : patch.claimDetails,
    notes: patch.notes === undefined ? current.notes : patch.notes,
  };
  const changed =
    next.location !== current.location ||
    next.defectTypeId !== current.defectTypeId ||
    next.workTypeId !== current.workTypeId ||
    next.claimDetails !== current.claimDetails ||
    next.notes !== current.notes;
  return { next, changed };
}
