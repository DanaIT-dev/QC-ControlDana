import { z } from 'zod';
import { SLA_CLOCK_KINDS, SLA_CLOCK_STATES } from './enums';

export const slaListQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().optional(),
    pageSize: z.coerce.number().int().positive().max(100).optional(),
    kind: z.enum(SLA_CLOCK_KINDS).optional(),
    state: z.enum(SLA_CLOCK_STATES).optional(),
    bucket: z
      .enum(['WARNING', 'DUE_TODAY', 'OVERDUE_1_2', 'OVERDUE_3_6', 'OVERDUE_7_PLUS', 'NO_DEADLINE'])
      .optional(),
    sortBy: z.enum(['deadline', 'overdueDays', 'actNumber']).optional(),
    sortDirection: z.enum(['asc', 'desc']).optional(),
  })
  .strict();

export type SlaListQuery = z.infer<typeof slaListQuerySchema>;

export interface SlaSummaryResponse {
  warning: number;
  dueToday: number;
  overdue1to2: number;
  overdue3to6: number;
  overdue7plus: number;
  noDeadline: number;
}

export interface SlaListItem {
  defectItemId: string;
  actId: string;
  officialNumber: string;
  formCode: 'S1' | 'S23';
  objectName: string;
  location: string;
  defectTypeName: string;
  responsibleNames: string[];
  kind: (typeof SLA_CLOCK_KINDS)[number];
  deadline: string | null;
  daysOffset: number | null;
  state: (typeof SLA_CLOCK_STATES)[number];
  escalationLevel: number | null;
  status: 'IN_PROGRESS' | 'COMPLETED';
}

export interface SlaListResponse {
  items: SlaListItem[];
  page: number;
  pageSize: number;
  total: number;
}
