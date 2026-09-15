/** Process-local observation only; never changes verification or carries file paths. */
export type VerificationProgress = { stage: string; completed: number; total: number }
const observers = new Set<(value: VerificationProgress) => void>()
export const verificationProgress = {
  subscribe(listener: (value: VerificationProgress) => void) { observers.add(listener) },
  unsubscribe(listener: (value: VerificationProgress) => void) { observers.delete(listener) },
}
export function reportVerificationProgress(stage: 'profile' | 'signature', completed: number, total: number): void {
  for (const observer of observers) observer({ stage, completed, total })
}
