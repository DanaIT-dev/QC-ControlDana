import { createServer, type Server } from 'node:http';
import { loadConfig } from '@sgr-registry/config';
import {
  getPrismaClient,
  prismaWithRlsTransaction,
  withWorkerDbContext,
} from '@sgr-registry/database';
import {
  resolveAttachmentQueueName,
  resolveMaintenanceQueueName,
  resolveNotificationQueueName,
} from '@sgr-registry/domain';
import {
  NotificationDispatcher,
  OutboxWriter,
  processNotificationJob,
  scheduleNotificationJobs,
  WorkerHeartbeat,
} from '@sgr-registry/jobs';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import { processAttachmentJob } from './attachment-scan';
import { createS3Client, ObjectStore, resolveAttachmentBucket } from './object-store';

export class WorkerReadyTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Worker ready timed out after ${timeoutMs}ms`);
    this.name = 'WorkerReadyTimeoutError';
  }
}

export interface StartWorkerRuntimeOptions {
  listenHealth?: boolean;
  installSignals?: boolean;
  scheduleOnStart?: boolean;
}

export interface WorkerRuntime {
  stop: () => Promise<void>;
}

function bullmqConnection(redisUrl: string): ConnectionOptions {
  return {
    url: redisUrl,
    maxRetriesPerRequest: null,
  };
}

async function waitUntilReadyBounded(
  targets: Array<{ waitUntilReady: () => Promise<unknown> }>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(targets.map((item) => item.waitUntilReady())),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new WorkerReadyTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function listenHealth(port: number): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.url === '/health' || request.url === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'ok', service: 'sgr-registry-worker' }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

export async function startWorkerRuntime(
  options: StartWorkerRuntimeOptions = {},
): Promise<WorkerRuntime> {
  const config = loadConfig();
  const connection = bullmqConnection(config.REDIS_URL);
  const rootPrisma = getPrismaClient(config.WORKER_DATABASE_URL);
  const prisma = prismaWithRlsTransaction(rootPrisma);
  const secret = config.RLS_CONTEXT_SECRET;
  const withWorker = <T>(fn: () => Promise<T>): Promise<T> =>
    withWorkerDbContext({ prisma: rootPrisma, secret, callback: fn });
  const heartbeatRedis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
  const notificationQueue = new Queue(resolveNotificationQueueName(), { connection });
  const attachmentQueue = new Queue(resolveAttachmentQueueName(), { connection });
  const maintenanceQueue = new Queue(resolveMaintenanceQueueName(), { connection });
  const dispatcher = new NotificationDispatcher(prisma, notificationQueue);
  const outboxWriter = new OutboxWriter(notificationQueue);
  const store = new ObjectStore(createS3Client(config), resolveAttachmentBucket(config));
  const heartbeat = new WorkerHeartbeat(heartbeatRedis);

  const notificationWorker = new Worker(
    resolveNotificationQueueName(),
    (job) => withWorker(() => processNotificationJob(dispatcher, prisma, job)),
    { connection, concurrency: 5 },
  );
  const attachmentWorker = new Worker(
    resolveAttachmentQueueName(),
    (job) => processAttachmentJob(job, { prisma, store, outboxWriter, rootPrisma, secret }),
    { connection, concurrency: 2 },
  );
  const maintenanceWorker = new Worker(resolveMaintenanceQueueName(), async () => ({ ok: true }), {
    connection,
    concurrency: 1,
  });

  const closables = [
    notificationWorker,
    attachmentWorker,
    maintenanceWorker,
    notificationQueue,
    attachmentQueue,
    maintenanceQueue,
  ];

  let healthServer: Server | undefined;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    await heartbeat.stop();
    if (healthServer) {
      await new Promise<void>((resolve) => healthServer?.close(() => resolve()));
    }
    await Promise.all(closables.map((item) => item.close().catch(() => undefined)));
    heartbeatRedis.disconnect();
  };

  try {
    await waitUntilReadyBounded(
      [
        notificationWorker,
        attachmentWorker,
        maintenanceWorker,
        notificationQueue,
        attachmentQueue,
        maintenanceQueue,
      ],
      config.WORKER_READY_TIMEOUT_MS,
    );
    if (options.scheduleOnStart !== false) {
      await withWorker(() => scheduleNotificationJobs(prisma, notificationQueue));
    }
    await heartbeat.start();
    if (options.listenHealth && config.WORKER_HEALTH_PORT > 0) {
      healthServer = await listenHealth(config.WORKER_HEALTH_PORT);
    }
  } catch (error) {
    await stop();
    throw error;
  }

  if (options.installSignals) {
    const onSignal = (): void => {
      void stop().finally(() => process.exit(0));
    };
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
  }

  console.log('Notification worker started');
  return { stop };
}
