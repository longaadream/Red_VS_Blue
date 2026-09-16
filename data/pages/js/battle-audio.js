;(function (root) {
  'use strict'
  const KEY = 'rvb_sound_volume'
  const volumeListeners = new Set()
  let sessionVolume = null
  function volume() {
    if (sessionVolume !== null) return sessionVolume
    try { const saved = root.localStorage.getItem(KEY); const n = saved === null ? 0.45 : Number(saved); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.45 } catch { return 0.45 }
  }
  function setVolume(value) {
    const n = Number(value)
    if (!Number.isFinite(n)) return
    sessionVolume = Math.max(0, Math.min(1, n))
    try { root.localStorage.setItem(KEY, String(sessionVolume)) } catch { /* Keep the setting for this page when storage is unavailable. */ }
    volumeListeners.forEach(function (update) { update() })
  }
  function tierFor(kind, value) {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return 0
    return kind === 'move' || kind === 'teleport' ? (n >= 5 ? 2 : n >= 3 ? 1 : 0) : (n >= 8 ? 2 : n >= 4 ? 1 : 0)
  }
  function cuesFor(events) {
    const sounds = new Map()
    function add(kind, value) {
      if (!Number.isFinite(value) || value <= 0) return
      const previous = sounds.get(kind)
      if (!previous || value > previous.value) sounds.set(kind, {kind:kind, value:value, tier:tierFor(kind,value)})
    }
    ;(events || []).forEach(function (event) {
      const r = event.result || {}
      if (r.cancelled || r.success === false) return
      if (event.kind === 'damage' || event.kind === 'heal') add(event.kind, Number(r.amount))
      if (['move', 'forceMove'].includes(event.kind) && [r.fromX,r.fromY,r.toX,r.toY].every(Number.isFinite)) {
        // Visual distance only; never rerun pathfinding or change movement cost.
        const distance = Math.max(Math.abs(r.toX-r.fromX), Math.abs(r.toY-r.fromY))
        add(r.movementKind === 'teleport' ? 'teleport' : 'move', distance)
      }
    })
    return Array.from(sounds.values())
  }
  function soundsFor(events) { return cuesFor(events).map(cue => cue.kind) }
  function create() {
    let context = null, master = null, disposed = false
    const voices = new Set()
    const last = new Map()
    const doc = root.document
    function stopSounds() {
      voices.forEach(function (osc) { osc.stop() })
    }
    function updateVolume() {
      if (!context || disposed) return
      master.gain.setValueAtTime(volume() * 0.5, context.currentTime)
      if (!volume()) stopSounds()
    }
    function visibility() { if (doc.hidden) stopSounds() }
    function unlock() {
      if (disposed || volume() === 0) return
      const Audio = root.AudioContext || root.webkitAudioContext
      if (!Audio) return
      try {
        if (!context) { context = new Audio(); master = context.createGain(); master.connect(context.destination) }
        if (context.state === 'suspended') context.resume().catch(function () {})
      } catch { /* Audio availability must not block play. */ }
    }
    volumeListeners.add(updateVolume)
    if (doc) { doc.addEventListener('pointerdown', unlock, {passive:true}); doc.addEventListener('keydown', unlock); doc.addEventListener('visibilitychange', visibility) }
    function tone(frequency, endFrequency, delay, duration, type, level) {
      if (voices.size >= 12) return
      const now = context.currentTime + delay, osc = context.createOscillator(), gain = context.createGain()
      osc.type = type || 'sine'
      osc.frequency.setValueAtTime(frequency, now)
      osc.frequency.exponentialRampToValueAtTime(Math.max(1,endFrequency), now + duration)
      gain.gain.setValueAtTime(0, now)
      gain.gain.linearRampToValueAtTime(level, now + 0.008)
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration)
      osc.connect(gain); gain.connect(master); voices.add(osc)
      osc.onended = function () { osc.disconnect(); gain.disconnect(); voices.delete(osc) }
      osc.start(now); osc.stop(now + duration + 0.01)
    }
    function play(kind, value) {
      if (disposed || !context || context.state !== 'running' || !volume() || (doc && doc.hidden) || voices.size >= 12) return false
      const now = context.currentTime
      if (last.has(kind) && now - last.get(kind) < 0.09) return false
      last.set(kind, now)
      master.gain.setValueAtTime(volume() * 0.5, now)
      const tier=tierFor(kind,value)
      if (kind === 'damage') { tone([210,170,125][tier],[65,48,32][tier],0,[0.12,0.18,0.26][tier],'triangle',[0.7,0.86,1.0][tier]); tone(720,120,0,0.055+tier*0.015,'sawtooth',0.11+tier*0.03) }
      else if (kind === 'move') { tone(310+tier*40,105,0,0.1+tier*0.045,'triangle',0.28+tier*0.03); tone(900,350,0.015,0.055+tier*0.025,'sine',0.07) }
      else if (kind === 'heal' || kind === 'success') { [523,659,784].forEach(function(f,i){tone(f,f*1.015,i*(0.025+tier*0.015),0.23+tier*0.09,'sine',0.08+tier*0.015)}) }
      else if (kind === 'warning') { tone(330,130,0,0.24,'triangle',0.16); tone(349,145,0.025,0.22,'sine',0.065) }
      else if (kind === 'teleport') { tone(240,1100,0,0.13,'sine',0.12); tone(1100,440,0.13,0.17,'sine',0.1) }
      else if (kind === 'click') { tone(820,420,0,0.055,'triangle',0.28); tone(1400,700,0,0.025,'sine',0.06) }
      else if (kind === 'notice') tone(440,440,0,0.15,'sine',0.1)
      else return false
      return true
    }
    return {play:play, unlock:unlock, playEvents:function(events){cuesFor(events).forEach(cue => play(cue.kind,cue.value))}, dispose:function(){
      if (disposed) return
      disposed = true
      stopSounds()
      volumeListeners.delete(updateVolume)
      if (doc) { doc.removeEventListener('pointerdown',unlock); doc.removeEventListener('keydown',unlock); doc.removeEventListener('visibilitychange',visibility) }
      if (context) { context.close().catch(function(){}); context=null }
    }}
  }
  root.BattleAudio = {create:create, soundsFor:soundsFor, cuesFor:cuesFor, tierFor:tierFor, volume:volume, setVolume:setVolume}
  function controls() {
    const input = root.document.querySelector('[data-sound-volume]')
    if (!input) return
    const label = root.document.querySelector('[data-sound-label]'), preview = create()
    input.value = Math.round(volume()*100)
    function show() { if(label) label.textContent = Number(input.value) ? input.value+'%' : '静音' }
    show()
    input.addEventListener('input',function(){setVolume(Number(input.value)/100);preview.unlock();show()})
    input.addEventListener('change',function(){preview.play('heal')})
    root.addEventListener('pagehide',function(){preview.dispose()},{once:true})
  }
  if (root.document) root.document.addEventListener('DOMContentLoaded',controls,{once:true})
})(typeof window !== 'undefined' ? window : globalThis)

