export interface OperationLookups {
  propertyObjects: Array<{
    id: string;
    name: string;
    address: string;
    active?: boolean;
    responsibleEngineerIds: string[];
  }>;
  customers: Array<{ id: string; officialName: string }>;
  defectTypes: Array<{ id: string; name: string }>;
  workTypes: Array<{ id: string; name: string }>;
  responsibleEngineers: Array<{ id: string; fullName: string }>;
  liableOrganizations: Array<{ id: string; officialName: string }>;
  alternativeContractors?: Array<{ id: string; officialName: string }>;
  canCreate?: {
    propertyObject: boolean;
    organization: boolean;
    workType: boolean;
    defectType: boolean;
    responsibleEngineer: boolean;
  };
}

export function engineersForObject(lookups: OperationLookups | undefined, objectId: string) {
  if (!lookups || !objectId) {
    return [];
  }
  const allowed = new Set(
    lookups.propertyObjects.find((object) => object.id === objectId)?.responsibleEngineerIds ?? [],
  );
  return lookups.responsibleEngineers
    .filter((engineer) => allowed.has(engineer.id))
    .map((engineer) => ({ id: engineer.id, label: engineer.fullName }));
}
