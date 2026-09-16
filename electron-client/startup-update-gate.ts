/** The startup page is informational. Local play only waits for local authority. */
export class StartupUpdateGate {
  entered = false
  checked = false
  observe(resource: string, client: string) { void resource; void client }
  canEnter(resource: string, client: string, localReady: boolean) {
    void client
    return localReady && resource !== 'applying'
  }
}
