const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const { createUpdateFeed } = require('./binary-update-feed.cjs')
const root = process.env.RVB_BINARY_QA_ROOT
const out = process.env.RVB_BINARY_QA_OUTPUT
fs.mkdirSync(path.join(out, 'harness-user-data'), { recursive: true })
app.setPath('userData', path.join(out, 'harness-user-data'))
const { NsisUpdater } = require(path.join(root, 'electron-client/dist/update-runtime.cjs'))
const { ElectronHttpExecutor } = require(path.join(root, 'electron-client/update-runtime/node_modules/electron-updater/out/electronHttpExecutor.js'))
const { ClientBinaryUpdates } = require(path.join(root, 'electron-client/dist/client-binary-updates.js'))
async function digest(file) {
  const hash = crypto.createHash('sha512')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
app.whenReady().then(async () => {
  const feed = createUpdateFeed(out)
  feed.server.listen(0, '127.0.0.1')
  await once(feed.server, 'listening')
  const url = `http://127.0.0.1:${feed.server.address().port}/`
  const targetFile = path.join(out, '0.1.4/RVB-Update-QA-0.1.4-Setup.exe')
  const fullSize = fs.statSync(targetFile).size
  const expectedHash = await digest(targetFile)
  const runRoot = fs.mkdtempSync(path.join(out, 'download-test-'))
  const results = { fullSize, expectedSha512: expectedHash, source: 'loopback HTTP using real NsisUpdater and real NSIS installers', actualInstallation: false, cases: [] }
  const cases = ['differential', 'missing-cache', 'already-current']
  // GitHub's provider deliberately uses single-range requests. Multipart is an
  // optional diagnostic, not the configuration used for manual acceptance.
  if (process.env.RVB_BINARY_QA_MULTIPART === '1') cases.splice(1, 0, 'differential-multipart')
  for (const testCase of cases) {
    const cacheBase = path.join(runRoot, testCase)
    fs.mkdirSync(cacheBase, { recursive: true })
    const config = path.join(cacheBase, 'app-update.yml')
    fs.writeFileSync(config, `provider: generic\nurl: ${url}\nupdaterCacheDirName: updater\n`)
    const adapter = { version: testCase === 'already-current' ? '0.1.4' : '0.1.3', name: 'red-vs-blue-update-qa', isPackaged: true, appUpdateConfigPath: config, userDataPath: cacheBase, baseCachePath: cacheBase, whenReady: async () => {}, quit: () => { throw Error('Must not install') }, relaunch: () => { throw Error('Must not relaunch') }, onQuit: () => {} }
    const updater = new NsisUpdater(null, adapter)
    updater.httpExecutor = new ElectronHttpExecutor()
    updater.setFeedURL({ provider: 'generic', url, useMultipleRangeRequest: testCase === 'differential-multipart' })
    await updater.netSession.setProxy({ mode: 'direct' })
    const logs = []
    updater.logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, (...args) => logs.push({ level, message: args.join(' ') })]))
    if (testCase.startsWith('differential')) {
      const helper = await updater.getOrCreateDownloadHelper()
      fs.mkdirSync(helper.cacheDir, { recursive: true })
      fs.copyFileSync(path.join(out, '0.1.3/RVB-Update-QA-0.1.3-Setup.exe'), path.join(helper.cacheDir, 'installer.exe'))
    }
    const start = feed.requests.length
    const client = new ClientBinaryUpdates(updater, () => {})
    await client.check()
    const downloads = feed.requests.slice(start)
    fs.writeFileSync(path.join(runRoot, `${testCase}.json`), JSON.stringify({ status: client.status, downloads, logs }, null, 2))
    if (testCase === 'already-current') {
      assert.equal(client.status.phase, 'current', JSON.stringify(logs))
      assert.equal(downloads.filter(r => r.path.endsWith('.exe')).length, 0)
    } else {
      assert.equal(client.status.phase, 'downloaded', JSON.stringify(logs))
      const helper = await updater.getOrCreateDownloadHelper()
      assert.equal(await digest(helper.file), expectedHash)
      const transfers = downloads.filter(r => r.path.endsWith('.exe'))
      const bytes = transfers.reduce((n, r) => n + r.bytes, 0)
      if (testCase.startsWith('differential')) {
        assert.ok(transfers.length && transfers.every(r => r.status === 206 && r.range), JSON.stringify(downloads))
        assert.ok(bytes < fullSize, 'Differential download did not save bytes')
        assert.ok(!logs.some(r => r.message.includes('fallback to full download')), JSON.stringify(logs))
      } else assert.ok(transfers.some(r => r.status === 200 && r.bytes === fullSize), JSON.stringify(downloads))
      const beforeRepeat = feed.requests.length
      await client.check()
      assert.equal(feed.requests.length, beforeRepeat, 'Downloaded update fetched twice')
    }
    const executableBytes = downloads.filter(r => r.path.endsWith('.exe')).reduce((n, r) => n + r.bytes, 0)
    results.cases.push({ testCase, status: client.status, executableBytes, totalResponseBytes: downloads.reduce((n, r) => n + r.bytes, 0), savedPercent: Math.round((1 - executableBytes / fullSize) * 10000) / 100, downloads, logs })
    console.log(`[binary-qa] ${testCase}: ${client.status.phase}; ${executableBytes}/${fullSize} installer bytes`)
  }
  fs.writeFileSync(path.join(out, 'download-results.json'), JSON.stringify(results, null, 2))
  await new Promise(resolve => feed.server.close(resolve))
  app.exit(0)
}).catch(error => { fs.writeFileSync(path.join(out, 'download-error.txt'), error.stack || String(error)); console.error(error); app.exit(1) })
