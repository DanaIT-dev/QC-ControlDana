import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../auth/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RedisModule } from '../auth/redis.module';
import { ReferenceDataController } from './reference-data.controller';
import { ReferenceDataService } from './reference-data.service';
import { DirectoryMutateRateLimitGuard } from './directory-mutate-rate-limit.guard';

@Module({
  imports: [PrismaModule, AuthModule, NotificationsModule, RedisModule],
  controllers: [ReferenceDataController],
  providers: [ReferenceDataService, DirectoryMutateRateLimitGuard],
})
export class ReferenceDataModule {}
