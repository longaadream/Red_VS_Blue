import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { expect, it } from 'vitest'

type MockNode = { textContent: string; hidden: boolean; disabled: boolean; dataset: Record<string, string>; children: MockNode[]; classList: { toggle(): void }; setAttribute(): void; append(...children: MockNode[]): void; appendChild(child: MockNode): void; replaceChildren(): void; addEventListener(): void; onclick?: () => Promise<void> | void }
it('confirms the selected map even when clicked during an in-flight poll, without duplicate submissions', async () => {
  const nodes = new Map<string, MockNode>(), intervals: Array<() => unknown> = []
  const element = (): MockNode => ({ textContent: '', hidden: false, disabled: false, dataset: {}, children: [] as MockNode[], classList: { toggle() {} }, setAttribute() {}, append(...children: MockNode[]) { this.children.push(...children) }, appendChild(child: MockNode) { this.children.push(child) }, replaceChildren() { this.children = [] }, addEventListener() {} })
  const node = (id: string) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id)! }
  const state = { phase: 'veto', serverNow: Date.now(), deadlineAt: Date.now() + 30000, players: [{ id: 'me', name: 'Me', banSubmitted: false }], maps: [{ id: 'map-a', name: '回风曲径', width: 8, height: 8 }] }
  let completePoll!: (value: unknown) => void, reads = 0, writes = 0
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
  vm.runInNewContext(readFileSync('data/pages/js/ranked-match.js', 'utf8'), {
    document: { getElementById: node, createElement: element, querySelectorAll: () => [] },
    location: { search: '?matchId=match' }, URLSearchParams, Date,
    setInterval: (cb: () => unknown) => intervals.push(cb),
    RvBRanked: { session: () => ({ account: { id: 'me' } }), drawMap() {}, api: async (_path: string, body?: unknown) => {
      if (body) { writes++; return { ...state, players: [{ ...state.players[0], banSubmitted: true }] } }
      if (++reads === 2) return new Promise(resolve => { completePoll = resolve })
      return state
    } },
  })
  await flush()
  node('mapCards').children[0].children[3].onclick!()
  expect(node('confirmBan').textContent).toBe('确认禁用「回风曲径」')
  intervals[0]()
  const submitted = node('confirmBan').onclick!()
  await node('confirmBan').onclick!()
  expect(node('confirmBan').disabled).toBe(true)
  expect(node('confirmBan').textContent).toBe('正在提交…')
  expect(writes).toBe(0)
  completePoll(state)
  await submitted
  expect(writes).toBe(1)
  expect(node('confirmBan').textContent).toBe('已提交 · 等待对方')
})
