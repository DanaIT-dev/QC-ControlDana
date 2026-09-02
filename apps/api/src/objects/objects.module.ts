import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../auth/prisma.module';
import { ObjectsController } from './objects.controller';
import { ObjectsService } from './objects.service';
import { ObjectCreateRateLimitGuard } from './object-create-rate-limit.guard';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ObjectsController],
  providers: [ObjectsService, ObjectCreateRateLimitGuard],
})
export class ObjectsModule {}
