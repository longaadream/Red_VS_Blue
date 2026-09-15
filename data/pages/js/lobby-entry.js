;(function () {
  var params = new URLSearchParams(location.search)
  // This legacy page only performs room admission/creation. Directories have
  // separate routes and never inherit one another's remembered server.
  if (params.has('create') || params.has('joinRoom')) return
  var lan = params.get('lobbyContext') !== 'public' && ['lan', 'local'].includes(params.get('server'))
  location.replace(lan ? 'lan.html?' + params.toString() : 'multiplayer.html')
})()
