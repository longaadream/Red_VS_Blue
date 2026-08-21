#!/usr/bin/env node
import { performance } from 'node:perf_hooks'

const runs = 100
const code = '(function(environment) { return environment.value + 1 })'
const started = performance.now()
const compiled = eval(code)
const coldMs = performance.now() - started
const warmStarted = performance.now()
let value = 0
for (let index = 0; index < runs; index += 1) value = compiled({ value })
const warmMs = performance.now() - warmStarted

console.log(JSON.stringify({
  benchmark: 'RED-82 dynamic-code compiler baseline',
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  runs,
  cold: { compilations: 1, milliseconds: coldMs },
  repeatedExecution: { compilations: 0, milliseconds: warmMs, result: value },
}, null, 2))
