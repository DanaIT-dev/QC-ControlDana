import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { loadConfig } from '@sgr-registry/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

@Injectable()
class RedisShutdown implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  onModuleDestroy(): void {
    this.redis.disconnect();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (): Redis => {
        const config = loadConfig();
        return new Redis(config.REDIS_URL, {
          maxRetriesPerRequest: 1,
          enableReadyCheck: true,
          lazyConnect: false,
        });
      },
    },
    RedisShutdown,
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
