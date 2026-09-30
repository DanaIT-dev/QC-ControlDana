const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const RUN_ID = /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertSafeTestBucket(bucket: string): string {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run attachment tests because NODE_ENV=production');
  }
  const name = bucket.trim();
  if (!name) {
    throw new Error('Refusing an empty test bucket name');
  }
  if (name === 'sgr-attachments' || /prod/i.test(name)) {
    throw new Error('Refusing to run attachment tests against a development or production bucket');
  }
  if (!name.endsWith('-test') && !name.endsWith('-e2e')) {
    throw new Error(
      `Refusing to run attachment tests: bucket "${name}" must end with "-test" or "-e2e".`,
    );
  }
  return name;
}

export function assertSafeTestEndpoint(endpoint: string): string {
  const value = endpoint.trim();
  if (!value) {
    throw new Error('Refusing an empty MinIO endpoint');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Refusing an unknown MinIO endpoint');
  }
  if (!LOCAL_HOSTS.has(url.hostname) || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new Error('Refusing an unknown MinIO endpoint');
  }
  return url.toString();
}

export function assertTestRunId(runId: string): string {
  if (!RUN_ID.test(runId)) {
    throw new Error('Refusing an unsafe test run id');
  }
  return runId;
}

export function testRunObjectPrefix(runId: string): string {
  return `runs/${assertTestRunId(runId)}/`;
}

export function assertOwnedTestPrefix(objectKey: string, runId?: string): void {
  if (objectKey.includes('..') || objectKey.includes('\\') || objectKey.startsWith('/')) {
    throw new Error('Refusing to delete an unsafe object key');
  }
  if (runId) {
    const prefix = testRunObjectPrefix(runId);
    if (!objectKey.startsWith(prefix)) {
      throw new Error('Refusing to delete an object outside the current test run');
    }
    return;
  }
  if (!objectKey.startsWith('attachments/') && !objectKey.startsWith('runs/')) {
    throw new Error('Refusing to delete an object outside the attachments test prefix');
  }
}
