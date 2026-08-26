import { Injectable } from '@nestjs/common';
import { loadConfig } from '@sgr-registry/config';
import { hashArgon2id, hashPassword, verifyPassword } from './crypto';

@Injectable()
export class Argon2PasswordHasher {
  async hash(password: string): Promise<string> {
    const config = loadConfig();
    return hashPassword(password, {
      memoryCost: config.ARGON2_MEMORY_COST,
      timeCost: config.ARGON2_TIME_COST,
    });
  }

  async hashUnchecked(password: string): Promise<string> {
    const config = loadConfig();
    return hashArgon2id(password, {
      memoryCost: config.ARGON2_MEMORY_COST,
      timeCost: config.ARGON2_TIME_COST,
    });
  }

  async verify(hash: string, password: string): Promise<boolean> {
    return verifyPassword(hash, password);
  }
}
