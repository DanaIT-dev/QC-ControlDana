import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthenticationGuard } from './authentication.guard';
import { BrowserOriginGuard } from './browser-origin.guard';
import { CsrfGuard } from './csrf.guard';
import { Argon2PasswordHasher } from './password-hasher';
import { RedisSessionStore } from './redis-session.store';
import { RolesGuard } from './roles.guard';
import { CapabilityGuard } from '../common/capability.guard';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    Argon2PasswordHasher,
    RedisSessionStore,
    AuthenticationGuard,
    RolesGuard,
    CsrfGuard,
    BrowserOriginGuard,
    CapabilityGuard,
  ],
  exports: [
    AuthService,
    AuthenticationGuard,
    RolesGuard,
    CsrfGuard,
    BrowserOriginGuard,
    RedisSessionStore,
    Argon2PasswordHasher,
    CapabilityGuard,
  ],
})
export class AuthModule {}
