export interface AdventureTickSchedule { scheduled:boolean }

export function scheduleAdventureTick(
  state:AdventureTickSchedule,
  enqueue:(operation:()=>Promise<void>)=>Promise<void>,
  operation:()=>Promise<void>,
  onError:(error:unknown)=>void,
):boolean {
  if(state.scheduled)return false
  state.scheduled=true
  void enqueue(operation).catch(onError).finally(()=>{state.scheduled=false})
  return true
}
