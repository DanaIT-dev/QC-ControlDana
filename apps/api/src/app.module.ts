import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { SafeExceptionFilter } from './common/safe-exception.filter';
import { HealthModule } from './health/health.module';

@Module({
  imports: [HealthModule],
  providers: [
    {
      provide: APP_FILTER,
      useClass: SafeExceptionFilter,
    },
  ],
})
export class AppModule {}
