import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  timestamp: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const componentStatusSchema = z.object({
  status: z.enum(['up', 'down']),
  latencyMs: z.number().optional(),
  message: z.string().optional(),
});

export const readyResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  timestamp: z.string(),
  components: z.object({
    postgres: componentStatusSchema,
    redis: componentStatusSchema,
  }),
});

export type ReadyResponse = z.infer<typeof readyResponseSchema>;
export type ComponentStatus = z.infer<typeof componentStatusSchema>;
