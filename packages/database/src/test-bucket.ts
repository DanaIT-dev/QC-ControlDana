export function assertSafeTestBucket(bucket: string): string {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run attachment tests because NODE_ENV=production');
  }
  if (!bucket.endsWith('-test')) {
    throw new Error(
      `Refusing to run attachment tests: bucket "${bucket}" must end with "-test". ` +
        'Development and production buckets will not be used.',
    );
  }
  if (bucket === 'sgr-attachments') {
    throw new Error('Refusing to run attachment tests against the development bucket');
  }
  return bucket;
}

export function assertOwnedTestPrefix(objectKey: string): void {
  if (!objectKey.startsWith('attachments/')) {
    throw new Error('Refusing to delete an object outside the attachments/ test prefix');
  }
  if (objectKey.includes('..') || objectKey.includes('\\')) {
    throw new Error('Refusing to delete an unsafe object key');
  }
}
