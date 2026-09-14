import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../../data/pages/js/skill-description.js', import.meta.url), 'utf8')
function page(storage) {
  const dialogs = []
  let restored = false
  const context = vm.createContext({ localStorage: storage, document: {
    activeElement: { isConnected: true, focus() { restored = true } },
    body: { appendChild(dialog) { dialogs.push(dialog) } },
    createElement() {
      const events = {}
      const button = { addEventListener(name, fn) { events[name] = fn } }
      return { events, setAttribute() {}, addEventListener(name, fn) { events[name] = fn },
        querySelector() { return button }, showModal() { this.open = true },
        close() { this.open = false }, remove() { this.removed = true } }
    },
  } })
  vm.runInContext(source, context)
  return { show: context.RvBSkillDescription.showGuide, dialogs, restored: () => restored }
}

test('首次详情仅弹一次，确认后跨页面及重新加载不再弹出', () => {
  const values = new Map()
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }
  const first = page(storage)
  assert.equal(first.dialogs.length, 0)
  first.show()
  first.show()
  assert.equal(first.dialogs.length, 1)
  assert.equal(values.size, 0, '显示不等于确认')
  first.dialogs[0].events.click()
  assert.equal(first.dialogs[0].removed, true)
  assert.equal(first.restored(), true)
  first.show()
  assert.equal(first.dialogs.length, 1)
  const next = page(storage)
  next.show()
  assert.equal(next.dialogs.length, 0)
  next.show(true)
  assert.equal(next.dialogs.length, 1, '已读后仍可从Tips主动打开')
  next.show(true)
  assert.equal(next.dialogs.length, 1, '主动重复点击不叠加弹窗')
})

test('存储不可用仍可阅读和确认，本页不重复；Esc不误记已读', () => {
  const current = page({ getItem() { throw Error('blocked') }, setItem() { throw Error('blocked') } })
  current.show()
  let prevented = false
  current.dialogs[0].events.cancel({ preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  assert.equal(current.dialogs[0].open, true)
  current.dialogs[0].events.click()
  current.show()
  assert.equal(current.dialogs.length, 1)
})
