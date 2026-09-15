/** Remembers discovered updates across failures and renderer reloads. */
export class StartupUpdateGate {
  entered = false
  checked = false
  private resourceRequired = false
  private clientRequired = false
  observe(resource: string, client: string) {
    if (['downloading', 'waiting', 'applying'].includes(resource)) this.resourceRequired = true
    if (resource === 'current') this.resourceRequired = false
    if (['downloading', 'downloaded'].includes(client)) this.clientRequired = true
  }
  canEnter(resource: string, client: string, localReady: boolean) {
    return this.checked && localReady && !this.resourceRequired && !this.clientRequired
      && ['current', 'error'].includes(resource) && ['current', 'error', 'unsupported'].includes(client)
  }
}
