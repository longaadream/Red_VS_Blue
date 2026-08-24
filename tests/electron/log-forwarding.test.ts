import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { PassThrough, Writable } from 'node:stream'
import ts from 'typescript'
import { describe, expect, test, vi } from 'vitest'

const root = path.resolve(__dirname, '..', '..')

type LogForwardingRecord = {
  event: 'electron.child-log-forwarding.error'
  runtime: 'electron-server' | 'electron-client'
  stream: 'stdout' | 'stderr'
  side: 'source' | 'target' | 'write'
  code: string
  message: string
  recoverable: boolean
  action: 'stop-forwarding' | 'report-error'
}

type AttachSafeLogForwarder = (
  source: NodeJS.ReadableStream,
  target: NodeJS.WritableStream,
  options: {
    runtime: LogForwardingRecord['runtime']
    stream: LogForwardingRecord['stream']
    report: (record: LogForwardingRecord) => void
    reportUnexpectedError: (error: Error, record: LogForwardingRecord) => void
  },
) => () => void

class RecordingWritable extends Writable {
  readonly chunks: Buffer[] = []
  writes = 0

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.writes += 1
    this.chunks.push(Buffer.from(chunk))
    callback()
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

class DeferredFailureWritable extends Writable {
  private pendingCallback: ((error?: Error | null) => void) | null = null

  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.pendingCallback = callback
  }

  failPendingWrite(code: string): void {
    if (!this.pendingCallback) throw new Error('No pending write to fail')
    const callback = this.pendingCallback
    this.pendingCallback = null
    callback(codedError(code))
  }
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(`${code} from controlled stream fixture`), { code })
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function loadSafeLogForwarder(relativePath: string): AttachSafeLogForwarder {
  const sourceText = read(relativePath)
  const sourceFile = ts.createSourceFile(
    relativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const declaration = sourceFile.statements.find((statement): statement is ts.FunctionDeclaration => (
    ts.isFunctionDeclaration(statement)
    && statement.name?.text === 'attachSafeLogForwarder'
  ))

  if (!declaration) {
    throw new Error(`${relativePath} does not define attachSafeLogForwarder`)
  }

  const compiled = ts.transpileModule(declaration.getText(sourceFile), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: relativePath,
  })
  const moduleValue: { exports: Record<string, unknown> } = { exports: {} }
  vm.runInNewContext(compiled.outputText, {
    exports: moduleValue.exports,
    module: moduleValue,
    setImmediate,
  }, { filename: relativePath })

  const forwarder = moduleValue.exports.attachSafeLogForwarder
  if (typeof forwarder !== 'function') {
    throw new Error(`${relativePath} does not export attachSafeLogForwarder`)
  }
  return forwarder as AttachSafeLogForwarder
}

const entries = [
  ['electron/main.ts', 'electron-server'],
  ['electron-client/main.ts', 'electron-client'],
] as const

describe.each(entries)('%s safe child log forwarding', (relativePath, runtime) => {
  test('forwards continuous output until the target pipe reports EPIPE, then stops once', async () => {
    const source = new PassThrough()
    const target = new RecordingWritable()
    const reports: LogForwardingRecord[] = []
    const unexpected = vi.fn()
    const dispose = loadSafeLogForwarder(relativePath)(source, target, {
      runtime,
      stream: 'stdout',
      report: (record) => reports.push(record),
      reportUnexpectedError: unexpected,
    })

    source.write('first\n')
    source.write('second\n')
    expect(target.text()).toBe('first\nsecond\n')

    target.destroy(codedError('EPIPE'))
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(reports).toEqual([expect.objectContaining({
      event: 'electron.child-log-forwarding.error',
      runtime,
      stream: 'stdout',
      side: 'target',
      code: 'EPIPE',
      recoverable: true,
      action: 'stop-forwarding',
    })])
    expect(unexpected).not.toHaveBeenCalled()

    const writesBeforeBrokenOutput = target.writes
    expect(() => {
      source.write('third\n')
      source.write('fourth\n')
    }).not.toThrow()
    expect(target.writes).toBe(writesBeforeBrokenOutput)
    expect(reports).toHaveLength(1)

    dispose()
    source.destroy()
  })

  test('keeps the target error listener until the final write callback settles', async () => {
    const source = new PassThrough()
    const target = new DeferredFailureWritable()
    const reports: LogForwardingRecord[] = []
    const unexpected = vi.fn()
    const dispose = loadSafeLogForwarder(relativePath)(source, target, {
      runtime,
      stream: 'stdout',
      report: (record) => reports.push(record),
      reportUnexpectedError: unexpected,
    })

    source.end('final\n')
    await new Promise<void>((resolve) => setImmediate(resolve))
    target.failPendingWrite('EPIPE')
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(reports).toEqual([expect.objectContaining({
      event: 'electron.child-log-forwarding.error',
      runtime,
      stream: 'stdout',
      code: 'EPIPE',
      recoverable: true,
      action: 'stop-forwarding',
    })])
    expect(unexpected).not.toHaveBeenCalled()

    dispose()
    source.destroy()
    target.destroy()
  })

  test('records source EPIPE without terminating the fixture process', () => {
    const source = new PassThrough()
    const target = new RecordingWritable()
    const reports: LogForwardingRecord[] = []
    const unexpected = vi.fn()
    const dispose = loadSafeLogForwarder(relativePath)(source, target, {
      runtime,
      stream: 'stderr',
      report: (record) => reports.push(record),
      reportUnexpectedError: unexpected,
    })

    expect(() => source.emit('error', codedError('EPIPE'))).not.toThrow()
    expect(reports).toEqual([expect.objectContaining({
      runtime,
      stream: 'stderr',
      side: 'source',
      code: 'EPIPE',
      recoverable: true,
      action: 'stop-forwarding',
    })])
    expect(unexpected).not.toHaveBeenCalled()

    dispose()
    source.destroy()
    target.destroy()
  })

  test('reports non-EPIPE stream errors through the unexpected-error path', () => {
    const source = new PassThrough()
    const target = new RecordingWritable()
    const reports: LogForwardingRecord[] = []
    const unexpected = vi.fn()
    const error = codedError('EACCES')
    const dispose = loadSafeLogForwarder(relativePath)(source, target, {
      runtime,
      stream: 'stderr',
      report: (record) => reports.push(record),
      reportUnexpectedError: (reportedError, record) => {
        unexpected(reportedError, record)
        target.emit('error', reportedError)
      },
    })

    expect(() => source.emit('error', error)).not.toThrow()
    expect(reports).toEqual([expect.objectContaining({
      runtime,
      stream: 'stderr',
      side: 'source',
      code: 'EACCES',
      recoverable: false,
      action: 'report-error',
    })])
    expect(unexpected).toHaveBeenCalledOnce()
    expect(unexpected).toHaveBeenCalledWith(error, reports[0])

    dispose()
    source.destroy()
    target.destroy()
  })
})

test.each(entries)('%s routes child stdout and stderr through the safe boundary', (relativePath) => {
  const source = read(relativePath)

  expect(source).not.toMatch(/\.stdout\?\.on\('data', \(d\) => process\.stdout\.write\(d\)\)/)
  expect(source).not.toMatch(/process\.stderr\.write\(d\)/)
  expect(source.match(/attachSafeLogForwarder\(/g)).toHaveLength(3)
  expect(source).toContain(".on('error'")
  expect(source).toContain(".on('exit'")
})

test('keeps existing non-EPIPE child process failure feedback intact', () => {
  const server = read('electron/main.ts')
  expect(server).toContain("spawnedProcess.on('error', (err) => {")
  expect(server).toContain("dialog.showErrorBox('服务器错误', String(err))")
  expect(server).toContain('shouldReportServerStartupFailure(code, stoppedByRequest)')
  expect(server).toContain("'服务器启动失败',")

  const client = read('electron-client/main.ts')
  expect(client).toContain("serverProcess.on('error', (err) => console.error('[client] server error:', err))")
  expect(client).toContain('lastServerExitCode = code')
  expect(client).toContain("console.log(`[client] local server exited: ${code}`)")
  expect(client).toContain('Local server exited with code ${lastServerExitCode}')
  expect(client).toContain("return { ok: false, error: exitMsg + detail }")
})
