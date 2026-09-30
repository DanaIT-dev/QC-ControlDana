export function releaseGateExitCode(status, mode) {
  if (status === 'BLOCKED') {
    return 1;
  }
  if ((mode === 'publish' || mode === 'production') && status === 'PARTIAL') {
    return 1;
  }
  return 0;
}
