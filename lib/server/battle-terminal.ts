export const CLIENT_TERMINAL_FORBIDDEN = 'CLIENT_TERMINAL_FORBIDDEN'

export interface ClientTerminalSubmissionError {
  code: typeof CLIENT_TERMINAL_FORBIDDEN
  message: 'Client-authored battle terminal results are forbidden'
}

const FORBIDDEN_TERMINAL_MESSAGE: ClientTerminalSubmissionError = {
  code: CLIENT_TERMINAL_FORBIDDEN,
  message: 'Client-authored battle terminal results are forbidden',
}

export function getClientTerminalSubmissionError(
  message: unknown,
): ClientTerminalSubmissionError | null {
  if (!message || typeof message !== 'object') return null
  const record = message as Record<string, unknown>
  const action = record.action && typeof record.action === 'object'
    ? record.action as Record<string, unknown>
    : null
  const hasTerminalField = Object.prototype.hasOwnProperty.call(record, 'winner')
    || Object.prototype.hasOwnProperty.call(record, 'terminalResult')
    || (action !== null && (
      action.type === 'gameOver'
      || Object.prototype.hasOwnProperty.call(action, 'winner')
      || Object.prototype.hasOwnProperty.call(action, 'terminalResult')
    ))
  return record.type === 'gameOver' || record.type === 'terminalResult' || hasTerminalField
    ? { ...FORBIDDEN_TERMINAL_MESSAGE }
    : null
}

export function syncRoomTerminalStatus(
  room: { status: string },
  state: unknown,
): boolean {
  if (!state || typeof state !== 'object') return false
  const terminalResult = (state as { terminalResult?: { status?: unknown } | null }).terminalResult
  if (terminalResult?.status !== 'finished') return false
  room.status = 'finished'
  return true
}
