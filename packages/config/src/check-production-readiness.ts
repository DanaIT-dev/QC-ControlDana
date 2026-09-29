import { assessProductionReadiness } from './production-readiness';

const failures = assessProductionReadiness(process.env);
if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`${failure.key}: ${failure.message}\n`);
  }
  process.stderr.write('production readiness check failed\n');
  process.exit(1);
}

process.stdout.write('production readiness check passed\n');
