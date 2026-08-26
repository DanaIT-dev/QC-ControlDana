import { Controller, Get, Inject, NotFoundException, Param, UseGuards } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { RegistryService } from './registry.service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller('acts')
@UseGuards(AuthenticationGuard)
export class ActsController {
  constructor(@Inject(RegistryService) private readonly registryService: RegistryService) {}

  @Get(':actId')
  detail(@CurrentUser() user: AuthenticatedUser, @Param('actId') actId: string) {
    if (!UUID_PATTERN.test(actId)) {
      throw new NotFoundException('Запись не найдена');
    }
    return this.registryService.actDetail(user, actId);
  }
}
