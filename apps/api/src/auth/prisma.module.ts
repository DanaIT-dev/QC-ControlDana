import { Global, Module } from '@nestjs/common';
import { loadConfig } from '@sgr-registry/config';
import { getPrismaClient } from '@sgr-registry/database';
import { PrismaService, PRISMA_CLIENT } from './prisma.tokens';

@Global()
@Module({
  providers: [
    {
      provide: PRISMA_CLIENT,
      useFactory: () => getPrismaClient(loadConfig().DATABASE_URL),
    },
    PrismaService,
  ],
  exports: [PRISMA_CLIENT, PrismaService],
})
export class PrismaModule {}
