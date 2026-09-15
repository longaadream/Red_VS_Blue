import dgram from 'node:dgram'
import os from 'node:os'
import { hostDiscoveryFromEnvironment, ipv4Broadcast } from '../electron-client/host-discovery'

/** Advertise the active native authority using the desktop discovery protocol. */
export function startLanBroadcast(port:number) {
  let stopped=false
  const sockets=new Set<dgram.Socket>()
  const send=()=>{
    try {
    const identity=hostDiscoveryFromEnvironment()
    if(!identity)return
    const interfaces=Object.values(os.networkInterfaces()).flatMap(items=>items??[])
      .filter(item=>item.family==='IPv4'&&!item.internal&&!item.address.startsWith('169.254.'))
    for(const network of interfaces){
      const socket=dgram.createSocket('udp4');sockets.add(socket)
      const close=()=>{sockets.delete(socket);try{socket.close()}catch{/* Socket already closed. */}}
      socket.on('error',error=>{console.warn('[lan-broadcast]',network.address,error.message);close()})
      socket.bind(0,network.address,()=>{
        if(stopped){close();return}
        try {
        socket.setBroadcast(true)
        const payload=Buffer.from(JSON.stringify({magic:'RVB_DISCOVER',...identity,name:identity.serverName,ip:network.address,ips:interfaces.map(i=>i.address),port}))
        socket.send(payload,7877,ipv4Broadcast(network.address,network.netmask),error=>{if(error)console.warn('[lan-broadcast]',network.address,error.message);close()})
        }catch(error){console.warn('[lan-broadcast]',network.address,error);close()}
      })
    }
    } catch(error) {
      console.warn('[lan-broadcast] Unable to advertise authority',error)
      for(const socket of sockets){try{socket.close()}catch{/* Already closed. */}}sockets.clear()
    }
  }
  send();const timer=setInterval(send,2000);timer.unref()
  return ()=>{stopped=true;clearInterval(timer);for(const socket of sockets){try{socket.close()}catch{/* Already closed. */}}sockets.clear()}
}
