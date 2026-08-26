import { Controller, Get, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { HealthResponse, ReadyResponse } from '@sgr-registry/contracts';
import { HealthService } from './health.service';

@Controller()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('health')
  health(): HealthResponse {
    return this.healthService.getHealth();
  }

  @Get('ready')
  async ready(@Res() reply: FastifyReply): Promise<void> {
    const result: ReadyResponse = await this.healthService.getReadiness();
    const statusCode = result.status === 'ready' ? 200 : 503;
    await reply.status(statusCode).send(result);
  }
}
