import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { loadConfig } from '@sgr-registry/config';
import { getPrismaClient } from '@sgr-registry/database';
import { AUTH_PRISMA_CLIENT, PrismaService, PRISMA_CLIENT } from './prisma.tokens.js';
import { RlsContextInterceptor } from './rls-context.interceptor.js';

@Global()
@Module({
  providers: [
    {
      provide: PRISMA_CLIENT,
      useFactory: () => getPrismaClient(loadConfig().DATABASE_URL),
    },
    {
      provide: AUTH_PRISMA_CLIENT,
      useFactory: () => getPrismaClient(loadConfig().AUTH_DATABASE_URL),
    },
    PrismaService,
    {
      provide: APP_INTERCEPTOR,
      useClass: RlsContextInterceptor,
    },
  ],
  exports: [PRISMA_CLIENT, AUTH_PRISMA_CLIENT, PrismaService],
})
export class PrismaModule {}
