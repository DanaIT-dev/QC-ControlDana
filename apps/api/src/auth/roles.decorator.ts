import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '@sgr-registry/contracts';

export const ROLES_KEY = 'sgr-roles';

export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
