import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = resolve(process.cwd(), 'data/pages')
const page = readFileSync(resolve(root, 'community.html'), 'utf8')
const script = readFileSync(resolve(root, 'js/community.js'), 'utf8')
const home = readFileSync(resolve(root, 'js/home-account.js'), 'utf8')

describe('RED-242 community UI contract', () => {
  it('keeps the community entry visible beside the primary online mode', () => {
    const index = readFileSync(resolve(root, 'index.html'), 'utf8')
    expect(index).toMatch(/id="communityEntry"[\s\S]*?进入在线社区[\s\S]*?好友 · 公告板 · 约桌/)
    expect(index.indexOf('id="communityEntry"')).toBeLessThan(index.indexOf('class="connection-groups"'))
    expect(readFileSync(resolve(root, 'official.html'), 'utf8')).toContain('href="community.html"')
  })

  it('declares the authenticated friend and board controls', () => {
    for (const id of ['communityLoginForm', 'friendSearchForm', 'friendsList', 'incomingList', 'outgoingList', 'blockedList', 'officialAnnouncement', 'postForm', 'boardPosts', 'boardMore']) {
      expect(page).toContain(`id="${id}"`)
    }
    expect(page).toMatch(/<details class="post-composer">[\s\S]*<summary>发布约桌 \/ 交流帖<\/summary>[\s\S]*id="postForm"/)
    for (const action of ['request', 'accept', 'reject', 'withdraw', 'remove', 'block', 'unblock']) expect(script).toContain("'" + action + "'")
    for (const route of ['/accounts?q=', '/friends', '/board', '/posts', '/replies/']) expect(script).toContain(route)
    expect(script).toContain('startOfficialPresence')
    expect(script).toContain('复制房间码')
    expect(script).not.toContain('window.location.href')
  })

  it('renders server supplied names and posts as text instead of HTML', () => {
    expect(script).toContain('element.textContent = value')
    expect(script).toContain("copy.appendChild(make('span', 'friend-row-name', displayName(value)))")
    expect(script).toContain("make('p', 'board-post-body', post.body || '')")
    expect(script).not.toContain('.innerHTML')
  })

  it('keeps home auth on the shared session and limits automatic lifecycle work', () => {
    expect(home).toContain("window.RvBUtils.readOfficialSession(origin)")
    expect(home).toContain("request(origin, '/official/me'")
    expect(home).toContain("request(origin, '/official/community/heartbeat'")
    expect(home).toContain('getCommunityLaunchId')
    expect(home).toContain('rvb_community_prompted:')
    expect(home).toContain('dialog[open]')
    expect(home).not.toContain("setInterval(autoConnect")
  })
})
