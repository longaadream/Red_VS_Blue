'use client'

import { useState } from 'react'

import styles from './page.module.css'

type ScenarioId = 'light-light' | 'dark-dark'

interface LaunchResult {
  roomId: string
  seed: number
  stateHash: string
  scenario: ScenarioId
  alignment: 'light' | 'dark'
  players: {
    alice: { playerId: string; name: string }
    bob: { playerId: string; name: string }
  }
  urls: { alice: string; bob: string }
  targetEvidence: {
    skillId: string
    expectedFilter: 'ally' | 'enemy'
    acceptedTargetPieceIds: string[]
  }
}

const SCENARIOS: Array<{
  id: ScenarioId
  title: string
  description: string
  target: string
  tone: 'light' | 'dark'
}> = [
  {
    id: 'light-light',
    title: '光 / 光镜像局',
    description: 'Alice 与 Bob 都使用 light 内容阵营，但仍按各自 ownerPlayerId 呈现为敌我。',
    target: '敌方目标：绯村剑心 · 天翔龙闪',
    tone: 'light',
  },
  {
    id: 'dark-dark',
    title: '暗 / 暗镜像局',
    description: 'Alice 与 Bob 都使用 dark 内容阵营；座位和内容阵营不会改变所有权关系。',
    target: '友方目标：古尔丹 · 邪能赐福',
    tone: 'dark',
  },
]

export default function SameAlignmentQaClient() {
  const [loading, setLoading] = useState<ScenarioId | null>(null)
  const [results, setResults] = useState<Partial<Record<ScenarioId, LaunchResult>>>({})
  const [errors, setErrors] = useState<Partial<Record<ScenarioId, string>>>({})

  async function launch(scenario: ScenarioId) {
    setLoading(scenario)
    setErrors(current => ({ ...current, [scenario]: undefined }))
    try {
      const response = await fetch('/api/debug/battle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'create-ui-acceptance-room', scenario }),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
      setResults(current => ({ ...current, [scenario]: payload as LaunchResult }))
    } catch (error) {
      setErrors(current => ({
        ...current,
        [scenario]: error instanceof Error ? error.message : String(error),
      }))
    } finally {
      setLoading(null)
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <div className={styles.eyebrow}>RED-43 · Local QA</div>
        <h1 className={styles.title}>同阵营对局客户端验收入口</h1>
        <p className={styles.lede}>
          创建固定 seed 的真实本地房间，并从 Alice 或 Bob 的视角打开正式 battle.html。
          启动页记录房间、玩家、状态 hash 与服务端目标集合；战斗页的 RED-43 面板显示客户端高亮是否与它一致。
        </p>

        <section className={styles.scenarios} aria-label="同阵营验收场景">
          {SCENARIOS.map(scenario => {
            const result = results[scenario.id]
            return (
              <article className={styles.card} data-tone={scenario.tone} key={scenario.id}>
                <h2 className={styles.scenarioName}>{scenario.title}</h2>
                <p className={styles.scenarioMeta}>
                  {scenario.description}<br />
                  {scenario.target}
                </p>
                <button
                  className={styles.button}
                  disabled={loading === scenario.id}
                  onClick={() => launch(scenario.id)}
                  data-testid={`create-${scenario.id}`}
                >
                  {loading === scenario.id ? '正在创建…' : '创建验收房间'}
                </button>

                {errors[scenario.id] && <p className={styles.error}>{errors[scenario.id]}</p>}

                {result && (
                  <div className={styles.result} data-testid={`result-${scenario.id}`}>
                    <dl className={styles.facts}>
                      <div className={styles.fact}><dt>Room</dt><dd>{result.roomId}</dd></div>
                      <div className={styles.fact}><dt>Seed</dt><dd>{result.seed}</dd></div>
                      <div className={styles.fact}><dt>State hash</dt><dd>{result.stateHash.slice(0, 12)}</dd></div>
                      <div className={styles.fact}><dt>Alice playerId</dt><dd>{result.players.alice.playerId}</dd></div>
                      <div className={styles.fact}><dt>Bob playerId</dt><dd>{result.players.bob.playerId}</dd></div>
                      <div className={styles.fact}>
                        <dt>Server targets</dt>
                        <dd>{result.targetEvidence.expectedFilter} · {result.targetEvidence.acceptedTargetPieceIds.length}</dd>
                      </div>
                    </dl>
                    <div className={styles.links}>
                      <a className={styles.link} href={result.urls.alice} target="_blank" rel="noreferrer">
                        打开 Alice 视角
                      </a>
                      <a className={styles.link} href={result.urls.bob} target="_blank" rel="noreferrer">
                        打开 Bob 视角
                      </a>
                    </div>
                  </div>
                )}
              </article>
            )
          })}
        </section>

        <section className={styles.steps}>
          <h2>验收顺序</h2>
          <ol>
            <li>分别创建光/光与暗/暗房间，记录 Room、Seed、State hash 和 Alice/Bob playerId。</li>
            <li>打开 Alice 视角，确认 RED-43 面板显示我方 8 枚、对方 8 枚。</li>
            <li>点击面板中的“加载验收技能”，确认目标高亮只落在预期 ownerPlayerId，且“UI / 规则一致”为“是”。</li>
            <li>打开 Bob 视角，确认左右敌我集合随 playerId 交换，而不是随 light/dark 内容阵营变化。</li>
          </ol>
        </section>
      </div>
    </main>
  )
}
