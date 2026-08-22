import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

function args(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--output') result.output = argv[++index]
    else if (!result.report) result.report = argv[index]
    else throw new Error(`Unknown argument ${argv[index]}`)
  }
  if (!result.report) throw new Error('Usage: npm run ai:self-play:report -- <report.json> [--output report.md]')
  return result
}

function table(headers, rows) {
  const line = values => `| ${values.join(' | ')} |`
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n')
}

function splitTable(rows) {
  return table(
    ['Key', 'Agent', 'Games', 'Wins', 'Losses', 'Draws', 'Failures'],
    rows.map(row => [row.key, row.agentId, row.games, row.wins, row.losses, row.draws, row.failures]),
  )
}

function render(report) {
  if (report.schemaVersion !== 1) throw new Error(`Unsupported report schemaVersion ${report.schemaVersion}`)
  const summary = report.summary
  const performance = report.performance
  const failures = summary.failures.length
    ? summary.failures.map(failure => `- ${failure.kind}: \`${failure.reproduction.matchId}\` seed=${failure.reproduction.rootSeed} action=${failure.reproduction.actionIndex} state=${failure.reproduction.stateHash}`).join('\n')
    : '- None'
  return `# Self-play report: ${report.suiteId}

- Gate: **${report.promotionGate.status}**
- Schema: ${report.schemaVersion}
- Commit: \`${report.codeCommit}\`
- Rules hash: \`${report.rulesHash}\`
- Content hash: \`${report.contentHash}\`
- Matches: ${summary.finishedMatches}/${summary.totalMatches} finished
- Actions: ${summary.totalActions}; rejected: ${summary.rejectedActions}; illegal rate: ${(summary.illegalActionRate * 100).toFixed(3)}%
- Loops: ${summary.loops}; budget failures: ${summary.budgetFailures}; exceptions: ${summary.exceptionFailures}
- Decision nodes: total ${summary.totalDecisionNodes}; max/action ${summary.maxDecisionNodes}
- Execution: ${report.execution.isolation}; processes=${performance.processCount}
- Throughput: ${performance.transitionsPerSecond?.toFixed(2) ?? 'n/a'} transitions/s; ${performance.gamesPerMinute?.toFixed(2) ?? 'n/a'} games/min
- Hardware: ${performance.hardware}
- Bottleneck: ${performance.bottleneck}

## Win matrix

${table(
  ['Agent', 'Opponent', 'Games', 'Wins', 'Losses', 'Draws', 'Failures'],
  summary.winMatrix.map(row => [row.agentId, row.opponentAgentId, row.games, row.wins, row.losses, row.draws, row.failures]),
)}

## Seat split

${splitTable(summary.seatSplits)}

## Roster split

${splitTable(summary.rosterSplits)}

## Seed split

${splitTable(summary.seedSplits)}

## Worst fixtures

${summary.worstMatches.map(matchId => `- \`${matchId}\``).join('\n') || '- None'}

## Hard-gate failures

${failures}

## Promotion interpretation

${report.promotionGate.note}
Evidence: ${report.promotionGate.competitiveEvidence.join(', ')}.
`
}

const options = args(process.argv.slice(2))
const report = JSON.parse(readFileSync(resolve(options.report), 'utf8'))
const markdown = render(report)
if (options.output) writeFileSync(resolve(options.output), markdown)
else process.stdout.write(markdown)
