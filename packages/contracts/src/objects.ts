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

export type ObjectsResponsibleAccountStatus = 'EMPTY' | 'LINKED' | 'UNRESOLVED' | 'AMBIGUOUS';

export interface ObjectsDirectoryItem {
  id: string;
  name: string;
  address: string | null;
  commissionedAt: string | null;
  warrantyEndsAt: string | null;
  sourceResponsibleEngineerName: string | null;
  responsibleEngineerAccountStatus: ObjectsResponsibleAccountStatus;
}

export interface ObjectsDirectoryResponse {
  items: ObjectsDirectoryItem[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  responsibleEngineerOptions: string[];
}
