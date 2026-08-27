export interface LinearGitHubSyncAdapter {
  currentBranch(): string
  writeEvidence(path: string, evidence: unknown): void
  stage(path: string): void
  hasStagedChanges(path: string): boolean
  commit(message: string, path: string): void
  push(): void
  now(): string
}

export interface LinearGitHubSyncInput {
  requiredBranch: string
  taskId: string
  evidencePath: string
  evidence: unknown
  commitMessage: string
}

export function syncLinearTrainingEvidence(
  adapter: LinearGitHubSyncAdapter,
  input: LinearGitHubSyncInput,
) {
  const branch = adapter.currentBranch()
  if (branch === 'main' || branch !== input.requiredBranch || !branch.includes(input.taskId)) {
    throw new Error(`GitHub sync requires task branch ${input.requiredBranch}; current=${branch}`)
  }
  // Write before network operations so a push failure never discards the local compact evidence.
  adapter.writeEvidence(input.evidencePath, input.evidence)
  adapter.stage(input.evidencePath)
  if (adapter.hasStagedChanges(input.evidencePath)) {
    adapter.commit(input.commitMessage, input.evidencePath)
  }
  adapter.push()
  return { status: 'synced' as const, branch, at: adapter.now(), evidencePath: input.evidencePath }
}
