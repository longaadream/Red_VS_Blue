;(function (root) {
  'use strict'
  function read(snapshot) {
    const value = snapshot && snapshot.extensions && snapshot.extensions.skillPresentation
    // Author definitions must never be evaluated in the browser.
    return value && value.version === 1 && !value.records ? value : {}
  }
  function display(snapshot, pieceId) {
    return (read(snapshot).bindings || []).filter(function (entry) { return entry.targetId === pieceId })
      .reduce(function (result, entry) { return Object.assign(result, entry.display) }, {})
  }
  function createPlayback() {
    let scope = null
    const highWater = new Map()
    const parsed = function (cue) { const m=/^p-(?:(\d+-(?:public|owner|allies|enemies|spectators))-)?(\d+)$/.exec(cue.id); return m ? {stream:m[1]||'legacy',sequence:Number(m[2])} : {stream:'invalid',sequence:0} }
    return {
      consume: function (model) {
        const nextScope = String(model.skillPresentationScope || '')
        const cues = model.skillCues || []
        const baseline = scope !== nextScope
        if (baseline) { scope = nextScope; highWater.clear() }
        // A reconnect initializes a new player and its initial snapshot is a baseline.
        // Out-of-order/retained history is never replayed. Different rooms have different scopes.
        const fresh=[]
        cues.slice().sort(function(a,b){return parsed(a).sequence-parsed(b).sequence}).forEach(function(cue){
          const item=parsed(cue), old=highWater.get(item.stream)||0
          if(item.sequence>old){if(!baseline)fresh.push(cue);highWater.set(item.stream,item.sequence)}
        })
        return fresh
      },
      reset: function () { scope = null; highWater.clear() },
    }
  }
  function createAudio() {
    let context = null
    return {
      play: function (preset) {
        const frequencies = {notice:440,success:660,warning:220}
        const Audio = root.AudioContext || root.webkitAudioContext
        if (!Audio || !frequencies[preset] || !root.navigator || !root.navigator.userActivation || !root.navigator.userActivation.hasBeenActive) return false
        context = context || new Audio()
        if (context.state !== 'running') return false
        const oscillator = context.createOscillator(), gain = context.createGain(), now = context.currentTime
        oscillator.type = 'sine'; oscillator.frequency.value = frequencies[preset]
        gain.gain.setValueAtTime(0,now); gain.gain.linearRampToValueAtTime(0.035,now+0.015); gain.gain.linearRampToValueAtTime(0,now+0.18)
        oscillator.connect(gain); gain.connect(context.destination)
        oscillator.onended = function () { oscillator.disconnect(); gain.disconnect() }
        oscillator.start(now); oscillator.stop(now+0.2)
        return true
      },
      dispose: function () { if (context) { const old=context;context=null;return old.close() } },
    }
  }
  root.BattleSkillPresentation = { read: read, display: display, createPlayback: createPlayback, createAudio:createAudio }
})(typeof window !== 'undefined' ? window : globalThis)
