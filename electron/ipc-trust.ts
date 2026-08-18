import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface IpcFrameLike {
  url: string
}

export interface IpcWebContentsLike {
  id: number
  mainFrame: IpcFrameLike
  isDestroyed?: () => boolean
}

export interface IpcInvokeEventLike {
  sender: IpcWebContentsLike
  senderFrame: IpcFrameLike | null
}

export interface TrustedWindowLike {
  webContents: IpcWebContentsLike
  isDestroyed?: () => boolean
}

export interface TrustedIpcTarget {
  role: string
  window: TrustedWindowLike | null
  allowUrl: (rawUrl: string) => boolean
}

export function isFileUrlWithinRoot(rawUrl: string, root: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'file:') return false
    const resolvedRoot = path.resolve(root)
    const target = path.resolve(fileURLToPath(url))
    const relative = path.relative(resolvedRoot, target)
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  } catch {
    return false
  }
}

export function assertTrustedIpcSender<T extends TrustedIpcTarget>(
  event: IpcInvokeEventLike,
  channel: string,
  targets: readonly T[],
): T {
  if (!event.senderFrame) {
    throw new Error(`[ipc:${channel}] Rejected sender without a sender frame`)
  }
  if (event.senderFrame !== event.sender.mainFrame) {
    throw new Error(`[ipc:${channel}] Rejected sender: IPC is restricted to the main frame`)
  }

  const target = targets.find((candidate) => {
    const trustedWindow = candidate.window
    return Boolean(
      trustedWindow
      && !trustedWindow.isDestroyed?.()
      && !trustedWindow.webContents.isDestroyed?.()
      && trustedWindow.webContents === event.sender,
    )
  })
  if (!target) {
    throw new Error(`[ipc:${channel}] Rejected sender outside the trusted window set`)
  }
  if (!target.allowUrl(event.senderFrame.url)) {
    throw new Error(`[ipc:${channel}] Rejected sender URL for ${target.role}: ${event.senderFrame.url}`)
  }
  return target
}
