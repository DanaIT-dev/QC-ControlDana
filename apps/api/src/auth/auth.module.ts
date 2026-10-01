import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AuthenticationGuard } from './authentication.guard.js';
import { BrowserOriginGuard } from './browser-origin.guard.js';
import { CsrfGuard } from './csrf.guard.js';
import { Argon2PasswordHasher } from './password-hasher.js';
import { RedisSessionStore } from './redis-session.store.js';
import { RolesGuard } from './roles.guard.js';
import { CapabilityGuard } from '../common/capability.guard.js';

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
