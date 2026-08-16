#!/usr/bin/env node
import { globSync, readFileSync } from 'node:fs'

const helpers = ['selectTarget', 'selectOption', 'dealDamage', 'healDamage', 'applyEffect', 'fireEvent', 'addRuleById', 'removeRuleById', 'addCardToHand', 'Math.random', 'Date.now']
const report = {}
for (const group of ['skills', 'rules', 'cards', 'effects']) {
  const files = globSync(`data/${group}/**/*.json`)
  report[group] = files.map((file) => {
    const source = readFileSync(file, 'utf8')
    return { file, helpers: helpers.filter((helper) => source.includes(helper)) }
  }).filter((entry) => entry.helpers.length)
}
console.log(JSON.stringify(report, null, 2))
