export interface DefectItemEngineerLink {
  defectItemId: string;
  userId: string;
}

export interface DefectItemLiableOrganizationLink {
  defectItemId: string;
  organizationId: string;
}

export function linkResponsibleEngineers(
  defectItemId: string,
  engineerIds: readonly string[],
): DefectItemEngineerLink[] {
  return [...new Set(engineerIds)].map((userId) => ({ defectItemId, userId }));
}

export function linkLiableOrganizations(
  defectItemId: string,
  organizationIds: readonly string[],
): DefectItemLiableOrganizationLink[] {
  return [...new Set(organizationIds)].map((organizationId) => ({
    defectItemId,
    organizationId,
  }));
}
