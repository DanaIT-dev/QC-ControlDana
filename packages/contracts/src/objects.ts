import { z } from 'zod';

export const objectsListQuerySchema = z
  .object({
    search: z.string().max(200).optional(),
    responsibleEngineer: z.string().max(100).optional(),
    page: z.coerce.number().int().positive().optional(),
    pageSize: z.coerce.number().int().positive().max(50).optional(),
    sort: z.enum(['source']).optional(),
  })
  .strict();

export type ObjectsListQuery = z.infer<typeof objectsListQuerySchema>;

export const linkObjectResponsibleEngineerSchema = z
  .object({
    userId: z.uuid().nullable(),
  })
  .strict();

export type LinkObjectResponsibleEngineerRequest = z.infer<
  typeof linkObjectResponsibleEngineerSchema
>;

export type ObjectsResponsibleAccountStatus = 'EMPTY' | 'LINKED' | 'UNRESOLVED' | 'AMBIGUOUS';

export type ObjectsResponsibleEngineer =
  | {
      id: string;
      fullName: string;
      status: 'ACTIVE' | 'ARCHIVED';
      linked: true;
      accessActive: boolean;
    }
  | {
      fullName: string;
      linked: false;
      linkState: 'UNMATCHED' | 'AMBIGUOUS' | 'INVALID';
    };

export interface ObjectsDirectoryItem {
  id: string;
  name: string;
  address: string | null;
  commissionedAt: string | null;
  warrantyEndsAt: string | null;
  responsibleEngineer: ObjectsResponsibleEngineer | null;
}

export interface ObjectsDirectoryResponse {
  items: ObjectsDirectoryItem[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  responsibleEngineerOptions: string[];
}
