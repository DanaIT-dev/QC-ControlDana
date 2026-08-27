import { Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { loadConfig } from '@sgr-registry/config';
import type { AuthenticatedUser } from './authenticated-user';
import { AuthService, toSafeProfile } from './auth.service';
import { AuthenticationGuard } from './authentication.guard';
import { BrowserOriginGuard } from './browser-origin.guard';
import { clearSessionCookie, setSessionCookie } from './cookie';
import { CsrfGuard } from './csrf.guard';
import { CurrentUser } from './current-user.decorator';

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(200)
  @UseGuards(BrowserOriginGuard)
  async login(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ReturnType<typeof toSafeProfile>> {
    const { profile, sessionId } = await this.authService.login(request.body, request);
    const config = loadConfig();
    setSessionCookie(reply, sessionId, config.NODE_ENV === 'production');
    return profile;
  }

  @Get('me')
  @UseGuards(AuthenticationGuard)
  me(@CurrentUser() user: AuthenticatedUser): ReturnType<typeof toSafeProfile> {
    return this.authService.me(user);
  }

  @Get('capabilities')
  @UseGuards(AuthenticationGuard)
  capabilities(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.capabilities(user);
  }

  @Post('change-password')
  @HttpCode(200)
  @UseGuards(BrowserOriginGuard, AuthenticationGuard, CsrfGuard)
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ReturnType<typeof toSafeProfile>> {
    const { profile, sessionId } = await this.authService.changePassword(
      user,
      request.body,
      request,
    );
    const config = loadConfig();
    setSessionCookie(reply, sessionId, config.NODE_ENV === 'production');
    return profile;
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(BrowserOriginGuard, AuthenticationGuard, CsrfGuard)
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ ok: true }> {
    await this.authService.logout(user, request);
    const config = loadConfig();
    clearSessionCookie(reply, config.NODE_ENV === 'production');
    return { ok: true };
  }

  @Post('logout-all')
  @HttpCode(200)
  @UseGuards(BrowserOriginGuard, AuthenticationGuard, CsrfGuard)
  async logoutAll(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ ok: true }> {
    await this.authService.logoutAll(user, request);
    const config = loadConfig();
    clearSessionCookie(reply, config.NODE_ENV === 'production');
    return { ok: true };
  }
}
