import { formatPersonShort } from '@sgr-registry/domain';

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
  responsibleEngineers: Array<{
    id: string;
    fullName: string;
    lastName?: string;
    firstName?: string;
    middleName?: string | null;
  }>;
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

export function personOption(person: {
  id: string;
  fullName: string;
  lastName?: string;
  firstName?: string;
  middleName?: string | null;
}) {
  return {
    id: person.id,
    label: formatPersonShort(
      person.lastName && person.firstName
        ? {
            lastName: person.lastName,
            firstName: person.firstName,
            middleName: person.middleName ?? null,
          }
        : person.fullName,
    ),
    title: person.fullName,
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
    .map((engineer) => personOption(engineer));
}
