export function shouldReportServerStartupFailure(
  exitCode: number | null,
  stopRequested: boolean,
): boolean {
  return exitCode === 1 && !stopRequested
}
