import { z } from 'zod';

const uuid = z.uuid();
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const objectsListQuerySchema = z
  .object({
    search: z.string().max(200).optional(),
    responsibleEngineer: z.string().max(100).optional(),
    page: z.coerce.number().int().positive().optional(),
    pageSize: z.coerce.number().int().positive().max(50).optional(),
    sort: z.enum(['source']).optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).optional(),
  })
  .strict();

export type ObjectsListQuery = z.infer<typeof objectsListQuerySchema>;

export const createPropertyObjectRequestSchema = z
  .object({
    name: z.string(),
    address: z.union([z.string(), z.null()]).optional(),
    commissionedAt: z.union([calendarDate, z.null()]).optional(),
    warrantyEndsAt: z.union([calendarDate, z.null()]).optional(),
    responsibleEngineerId: z.union([uuid, z.null()]).optional(),
    responsibleEngineerIds: z.array(uuid).optional(),
    responsibleEngineerName: z.union([z.string(), z.null()]).optional(),
  })
  .strict();

export type CreatePropertyObjectRequest = z.infer<typeof createPropertyObjectRequestSchema>;

export const linkObjectResponsibleEngineerSchema = z
  .object({
    userId: z.uuid().nullable().optional(),
    userIds: z.array(z.uuid()).optional(),
  })
  .strict();

export type LinkObjectResponsibleEngineerRequest = z.infer<
  typeof linkObjectResponsibleEngineerSchema
>;

export const updatePropertyObjectRequestSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    name: z.string(),
    address: z.union([z.string(), z.null()]).optional(),
    active: z.boolean().optional(),
    responsibleEngineerIds: z.array(uuid).optional(),
  })
  .strict();

export type UpdatePropertyObjectRequest = z.infer<typeof updatePropertyObjectRequestSchema>;

export type ObjectsResponsibleAccountStatus = 'EMPTY' | 'LINKED' | 'UNRESOLVED' | 'AMBIGUOUS';

export type ObjectsResponsibleEngineer =
  | {
      id: string;
      lastName?: string;
      firstName?: string;
      middleName?: string | null;
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
  active: boolean;
  version: number;
  responsibleEngineer: ObjectsResponsibleEngineer | null;
  responsibleEngineers: ObjectsResponsibleEngineer[];
}

export interface ObjectsDirectoryResponse {
  items: ObjectsDirectoryItem[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  responsibleEngineerOptions: string[];
  canCreate: boolean;
  canEdit: boolean;
  createEngineerOptions: Array<{
    id: string;
    lastName?: string;
    firstName?: string;
    middleName?: string | null;
    fullName: string;
  }>;
}
