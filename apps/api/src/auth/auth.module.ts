import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthenticationGuard } from './authentication.guard';
import { BrowserOriginGuard } from './browser-origin.guard';
import { CsrfGuard } from './csrf.guard';
import { Argon2PasswordHasher } from './password-hasher';
import { RedisSessionStore } from './redis-session.store';
import { RolesGuard } from './roles.guard';

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
  ],
  exports: [AuthService, AuthenticationGuard, RolesGuard, CsrfGuard, RedisSessionStore],
})
export class AuthModule {}
