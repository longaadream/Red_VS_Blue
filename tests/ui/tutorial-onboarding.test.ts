import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync('data/pages/tutorial.html', 'utf8')
const runtime = readFileSync('data/pages/js/tutorial/tutorial-lesson-runtime.js', 'utf8')

describe('tutorial onboarding', () => {
  it('teaches the three first-match concepts before lesson selection', () => {
    expect(page).toContain('第一次对局前的三个要点')
    expect(page).toContain('先保核心')
    expect(page).toContain('移动和技能共用 AP')
    expect(page).toContain('合法高亮')
  })

  it('restores lesson completion and points to the next lesson', () => {
    expect(page).toContain("localStorage.getItem('rvb_tutorial_status:' + lesson.id)")
    expect(page).toContain("saved.status === 'completed'")
    expect(runtime).toContain("saveLessonStatus(global.localStorage, lesson.id, 'completed')")
    expect(page).toContain("'从这里开始'")
    expect(page).toContain("'再练一次'")
  })
})
