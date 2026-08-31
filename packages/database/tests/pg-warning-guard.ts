const PG_QUERY_WARNING = /Calling client\.query\(\) when the client is already executing a query/;

const warnings: string[] = [];

process.on('warning', (warning) => {
  if (PG_QUERY_WARNING.test(warning.message)) {
    warnings.push(`${warning.name}: ${warning.message}`);
  }
});

export function pgQueryDeprecationWarnings(): readonly string[] {
  return warnings;
}

export function assertNoPgQueryDeprecationWarning(): void {
  if (warnings.length > 0) {
    throw new Error(warnings[0]);
  }
}
