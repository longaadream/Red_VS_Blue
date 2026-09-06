(function (global) {
  'use strict'
  const PLAYER = 'training-red'
  const OPPONENT = 'training-blue'
  const light = ['uther', 'jaina', 'anduin', 'tracer', 'tyrande', 'turalyon', 'velen', 'blue-tirion-fordring']
  const dark = ['reaper', 'red-blackwidow', 'red-illidan', 'dark-ulquiorra', 'dark-grimmjow', 'guldan', 'dark-aizen', 'red-obito']
  const lessons = [
    {
      id: 'first-victory', number: 1, title: '第一场胜利', size: 2, ownTurn: 3,
      guidedOpening: { templateId: 'uther', targetTemplateId: 'reaper', skillId: 'blessed-hammer', moveTo: { x: 8, y: 7 } },
      summary: '移动、释放技能，亲手消灭对方最后一枚场上核心。',
      intro: '欢迎入社！这一局我会先带你亲手操作。先记住：自己的场上核心全灭就会输，消灭对方场上全部核心就能赢。我们一步一步来。',
      help: '先点乌瑟尔看“祝福之锤”：1 AP、两格内一个敌人。可以移动后再使用，也可以让吉安娜先行动。预备区和普通召唤物不能保住已经全灭的场上核心。',
      placement: [[PLAYER, 'uther', 6, 7], [PLAYER, 'jaina', 5, 8], [OPPONENT, 'reaper', 10, 7], [OPPONENT, 'red-blackwidow', 14, 7]],
      cue: { cells: [{ x: 8, y: 7 }] },
    },
    {
      id: 'reinforcements', number: 2, title: '安排增援与行动', size: 3, ownTurn: 1, progressive: true,
      guidedOpening: { kind: 'deployment' },
      summary: '自己选择增援和落点，安排每回合的行动点与手牌。',
      intro: '这次从开局开始。现在桌上各有一枚先锋，其他棋子还在预备区。轮到你时，先选增援，再安排这个回合。',
      help: '候选中选一枚，再点合法格完成免费部署。新棋子本回合第一次普通移动免费，也可以留在原位行动。幸运币点一次预览，再点同一张打出；什么时候用，由你决定。',
      placement: [[PLAYER, 'uther', 6, 7], [OPPONENT, 'reaper', 12, 7]],
    },
    {
      id: 'protect-cores', number: 3, title: '保护自己的核心', size: 3, ownTurn: 4,
      guidedOpening: { kind: 'protection', templateId: 'uther', targetTemplateId: 'reaper', skillId: 'blessed-hammer', moveTo: { x: 7, y: 7 } },
      summary: '治疗、护盾、撤退或反击，选择自己的保命办法。',
      intro: '这盘练习棋里，乌瑟尔已经受伤，只剩 8 点生命。先看看附近的敌人，再决定怎么帮他。治疗、加盾、换位置、反击都可以考虑。',
      help: '安度因的圣光闪耀花 1 AP，治疗七格内友军。圣光盾要先付 2 AP，对自己施放返还 1 AP。也可以撤退或先攻击威胁来源，不必按固定顺序。',
      placement: [[PLAYER, 'uther', 6, 7, 8], [PLAYER, 'jaina', 5, 8], [PLAYER, 'anduin', 6, 6], [OPPONENT, 'reaper', 9, 7], [OPPONENT, 'red-blackwidow', 14, 7], [OPPONENT, 'red-illidan', 12, 9]],
    },
    {
      id: 'terrain', number: 4, title: '找到进攻机会', size: 4, ownTurn: 4,
      guidedOpening: { kind: 'terrain', templateId: 'uther', targetTemplateId: 'red-blackwidow', skillId: 'blessed-hammer', moveTo: { x: 15, y: 8 } },
      summary: '查看地形、范围与冷却，自主改变进攻位置。',
      intro: '这局中间有掩体。能不能走过去，和技能能不能穿过去，是两件事。先看清，再决定从哪边进攻。',
      help: '掩体可以站人，但挡弹射物；墙不能站且挡弹道；洞穴不能站但允许弹道通过。不是所有技能都是弹射物。可以绕路、换目标或查看其他技能的合法目标。',
      placement: [[PLAYER, 'uther', 13, 8], [PLAYER, 'jaina', 12, 7], [PLAYER, 'anduin', 11, 9], [PLAYER, 'tracer', 8, 7], [OPPONENT, 'red-blackwidow', 17, 8], [OPPONENT, 'reaper', 16, 7], [OPPONENT, 'red-illidan', 16, 9], [OPPONENT, 'dark-ulquiorra', 17, 11]],
      cue: { cells: [{ x: 15, y: 8 }] },
    },
    {
      id: 'charge', number: 5, title: '把优势变成胜利', size: 6, ownTurn: 1, progressive: true,
      guidedOpening: { kind: 'charge' },
      summary: '判断结晶争夺风险，决定何时使用队伍充能。',
      intro: '这一局继续由你安排部署和行动。战场上出现新资源时，我再提醒你。先想办法站稳、进攻。',
      help: '核心阵亡可留下中立结晶，击杀不是自动获得 CP。普通移动到结晶格可拾取，双方都能争夺；也可以放弃。充能技能同时检查 AP、CP 和冷却，先看费用再决定何时使用。',
      placement: [[PLAYER, 'uther', 6, 7], [OPPONENT, 'reaper', 12, 7]],
    },
    {
      id: 'full-match', number: 6, title: '独立完整对战', size: 8, ownTurn: 1, standard: true,
      guidedOpening: { kind: 'full-match' },
      summary: '完整八枚阵容与正常部署，自主指挥直到终局。',
      intro: '最后一局，使用完整八枚阵容、正常先锋和候选，你来安排所有行动。当前是本地场景试作，尚未接入正式房间准备和回合计时；对手是基础练习 AI，不记真人战绩。',
      help: '先看是否需要增援，再看 AP、CP、核心生命和对方位置。查看真实技能费用与目标，自己选择行动。没有强制路线，点结束回合后观察对手；最后一枚场上核心消失会导致败北。',
    },
  ].map(function (lesson) {
    return Object.assign(lesson, {
      schemaVersion: 'rvb-tutorial-lesson/v1', rootSeed: 18700 + lesson.number,
      mapId: 'large-hole-arena', player: { playerId: PLAYER, roster: light.slice(0, lesson.size) },
      opponent: { playerId: OPPONENT, roster: dark.slice(0, lesson.size) },
    })
  })

  function get(id) { return lessons.find(function (lesson) { return lesson.id === id }) || null }
  function assert(condition, message) { if (!condition) throw new Error('[tutorial lesson] ' + message) }

  async function createBattle(engine, lesson) {
    assert(lesson && get(lesson.id), 'unknown lesson')
    const rosters = [lesson.opponent, lesson.player].map(function (side, index) {
      return { playerId: side.playerId, faction: index === 0 ? 'red' : 'blue', pieces: side.roster.map(function (id) {
        const piece = engine.getPieceById(id)
        assert(piece, 'missing template ' + id)
        return piece
      }) }
    })
    const startTime = 1750000000000
    const state = await engine.createInitialBattleForPlayers([PLAYER, OPPONENT], [], rosters, lesson.mapId, {
      firstPlayerId: OPPONENT, rootSeed: lesson.rootSeed,
      profileIdentity: engine.tutorialProfileIdentity,
      deploymentEnabled: !!lesson.standard, deploymentStartedAt: startTime,
    })
    assert(state, 'battle initialization failed')
    if (!lesson.standard) {
      const all = state.pieces.slice()
      const placed = []
      const occupied = new Set()
      lesson.placement.forEach(function (entry) {
        const piece = all.find(function (p) { return p.ownerPlayerId === entry[0] && p.templateId === entry[1] })
        const tile = state.map.tiles.find(function (t) { return t.x === entry[2] && t.y === entry[3] })
        const cellKey = entry[2] + ',' + entry[3]
        assert(piece && tile && tile.props.walkable && !occupied.has(cellKey), 'invalid placement ' + entry.join(','))
        occupied.add(cellKey)
        piece.x = entry[2]; piece.y = entry[3]; piece.isCore = true
        if (entry[4] !== undefined) {
          assert(entry[4] > 0 && entry[4] <= piece.maxHp, 'invalid staged HP')
          piece.currentHp = entry[4]
        }
        placed.push(piece)
      })
      const reserves = {}
      ;[PLAYER, OPPONENT].forEach(function (id) {
        reserves[id] = all.filter(function (p) { return p.ownerPlayerId === id && !placed.includes(p) })
        reserves[id].forEach(function (p) { p.x = null; p.y = null; p.isCore = true })
        assert(lesson.progressive || reserves[id].length === 0, 'snapshot has unstaged pieces')
      })
      state.pieces = placed
      state.actions = []
      state.deployment = {
        mode: 'progressive-reserve-v1', status: 'turn-ready', playerIds: [OPPONENT, PLAYER],
        choices: {}, locks: {}, startedAt: startTime, deadlineAt: startTime, revision: 0,
        openingVanguardsInitialized: true, reserves: reserves,
        reserveCounts: { [PLAYER]: reserves[PLAYER].length, [OPPONENT]: reserves[OPPONENT].length },
        initialPositions: Object.fromEntries(placed.map(function (p) { return [p.instanceId, { x: p.x, y: p.y }] })),
      }
      if (!lesson.progressive) {
        state.turn.currentPlayerId = PLAYER
        state.turn.turnNumber = lesson.ownTurn * 2
        state.turn.phase = 'action'
        state.players.forEach(function (p) {
          p.actionPoints = p.playerId === PLAYER ? lesson.ownTurn : 0
          p.maxActionPoints = lesson.ownTurn
          p.chargePoints = 0; p.hand = []; p.discardPile = []
        })
      }
    }
    state.extensions = state.extensions || {}
    state.extensions.tutorialLesson = { id: lesson.id, rootSeed: lesson.rootSeed, scenario: !lesson.standard }
    return state
  }

  // Informational events never gate legal battle commands or require a specific route.
  function observe(lesson, before, after, action, seen) {
    const notices = []
    function once(key, text) { if (!seen.has(key)) { seen.add(key); notices.push({ key: key, text: text }) } }
    if (after.terminalResult) return notices
    const own = after.players.find(function (p) { return p.playerId === PLAYER })
    const previous = before.players.find(function (p) { return p.playerId === PLAYER })
    if (action.playerId === PLAYER && action.type === 'deployReservePiece') once('deploy', '增援已经上场。部署不花行动点，新棋子仅本回合第一次普通移动免费，也可以留在原位行动。')
    if (action.playerId === PLAYER && action.type === 'move') once('move', own.actionPoints === previous.actionPoints ? '位置变了，行动点没有减少。这次使用了免费首移。' : '位置变了。普通移动和技能共用行动点，接下来由你安排。')
    if (action.playerId === PLAYER && action.type === 'playCard') once('card', '卡牌已经结算。查看实际资源和效果，接下来也可以换一枚棋子行动。')
    if (action.playerId === PLAYER && action.type === 'useChargeSkill') once('charge-skill', '充能技能已经结算。对照 AP 和 CP 的变化，再决定下一步。')
    if (own.chargePoints > previous.chargePoints) once('charge-gained', '队伍充能增加了。使用充能技能前，同时查看 AP、CP 和冷却。')
    const crystals = after.extensions && after.extensions.tileEffects || []
    if (crystals.some(function (t) { return t.tileType === 'charge-crystal' })) once('crystal', '阵亡位置留下了中立充能结晶，双方都可以争夺。普通移动落在结晶格可拾取；也可以放弃，继续进攻。')
    const cores = after.pieces.filter(function (p) { return p.ownerPlayerId === PLAYER && p.isCore && p.currentHp > 0 && Number.isInteger(p.x) && Number.isInteger(p.y) })
    if (cores.length === 1) once('last-core', '这是你最后一枚场上核心。预备区和普通召唤物不能保住场上已经全灭的核心。')
    after.pieces.forEach(function (p) {
      const old = before.pieces.find(function (candidate) { return candidate.instanceId === p.instanceId })
      if (p.ownerPlayerId === PLAYER && old && p.currentHp > old.currentHp) once('healed', p.name + '恢复了 ' + (p.currentHp - old.currentHp) + ' 点生命。治疗恢复的是已损失的生命。')
    })
    return notices
  }

  global.RvBTutorialLessons = Object.freeze({ all: lessons, get: get, createBattle: createBattle, observe: observe, PLAYER: PLAYER, OPPONENT: OPPONENT })
})(typeof window !== 'undefined' ? window : globalThis)
