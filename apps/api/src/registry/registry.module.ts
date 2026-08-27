import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../auth/prisma.module';
import { OperationsModule } from '../operations/operations.module';
import { ActsController } from './acts.controller';
import { RegistryController } from './registry.controller';
import { RegistryService } from './registry.service';

@Module({
  imports: [PrismaModule, AuthModule, OperationsModule],
  controllers: [RegistryController, ActsController],
  providers: [RegistryService],
  exports: [RegistryService],
})
export class RegistryModule {}
