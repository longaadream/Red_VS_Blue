package com.redvsblue.client;

import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import android.content.Intent;
import android.os.Build;
import org.json.*;
import java.io.*;
import java.net.*;
import java.util.*;
import java.util.concurrent.*;

@CapacitorPlugin(name="AndroidHost",permissions={@Permission(alias="notifications",strings={"android.permission.POST_NOTIFICATIONS"})})
public class AndroidHostPlugin extends Plugin {
    volatile boolean localPage;
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private void requirePage()throws IOException{if(!localPage)throw new IOException("请在游戏内管理手机主机");}
    interface Job{JSObject run()throws Exception;}
    private void run(PluginCall call,Job job){try{requirePage();worker.execute(()->{try{requirePage();call.resolve(job.run());}catch(Exception e){call.reject(e.getMessage(),e);}});}catch(Exception e){call.reject(e.getMessage(),e);}}
    private JSObject status()throws Exception {
        JSONArray ips=new JSONArray();List<String> primary=new ArrayList<>(),other=new ArrayList<>();Enumeration<NetworkInterface> interfaces=NetworkInterface.getNetworkInterfaces();
        if(interfaces!=null)while(interfaces.hasMoreElements()){NetworkInterface ni=interfaces.nextElement();if(!ni.isUp()||ni.isLoopback())continue;Enumeration<InetAddress> addresses=ni.getInetAddresses();while(addresses.hasMoreElements()){InetAddress address=addresses.nextElement();if(address instanceof Inet4Address&&address.isSiteLocalAddress()&&!address.isLoopbackAddress()&&!address.isLinkLocalAddress()){
            (ni.getName().matches("(?i).*(wlan|swlan|ap|eth|bridge).*" )?primary:other).add(address.getHostAddress());
        }}}
        for(String ip:primary)ips.put(ip);if(primary.isEmpty())for(String ip:other)ips.put(ip);
        return new JSObject().put("running","running".equals(AndroidHostService.state)).put("state",AndroidHostService.state).put("notice",AndroidHostService.error).put("port",2567).put("ips",ips).put("profileIdentity",AndroidHostService.ready==null?JSONObject.NULL:AndroidHostService.ready.optJSONObject("profileIdentity"));
    }
    @PluginMethod public void info(PluginCall call){run(call,this::status);}
    @PluginMethod public void start(PluginCall call){
        if(Build.VERSION.SDK_INT>=33&&getPermissionState("notifications")!=PermissionState.GRANTED){requestPermissionForAlias("notifications",call,"notificationResult");return;}
        startAllowed(call);
    }
    @PermissionCallback private void notificationResult(PluginCall call){if(getPermissionState("notifications")==PermissionState.GRANTED)startAllowed(call);else call.reject("手机开房需要显示运行通知，请允许通知后重试");}
    private void startAllowed(PluginCall call){run(call,()->{
        synchronized(AndroidHostService.LOCK){
            if(!AndroidHostService.active()){
                AndroidMaintenancePlugin content=(AndroidMaintenancePlugin)bridge.getPlugin("AndroidMaintenance").getInstance();
                content.prepareHost();AndroidHostService.cancelPendingStart=false;AndroidHostService.state="starting";
                Intent intent=new Intent(getContext(),AndroidHostService.class);try{if(Build.VERSION.SDK_INT>=26)getContext().startForegroundService(intent);else getContext().startService(intent);}catch(Exception e){AndroidHostService.state="failed";throw e;}
            }
        }
        long deadline=System.currentTimeMillis()+100000;
        while("starting".equals(AndroidHostService.state)&&System.currentTimeMillis()<deadline)Thread.sleep(100);
        if(!"running".equals(AndroidHostService.state))throw new IOException(AndroidHostService.error.isEmpty()?("starting".equals(AndroidHostService.state)?"主机启动超时":"主机启动已取消"):AndroidHostService.error);
        return status().put("ok",true).put("localUrl","http://127.0.0.1:2567");
    });}
    @PluginMethod public void relay(PluginCall call){run(call,()->{
        String action=call.getString("action","status");
        if(!Arrays.asList("publish","stop","status").contains(action))throw new IOException("未知的转发操作");
        if(action.equals("status")&&!AndroidHostService.active())return new JSObject().put("ok",true).put("published",JSONObject.NULL);
        return new JSObject(AndroidHostService.control(new JSONObject(call.getData().toString())).toString());
    });}
    @PluginMethod public void stop(PluginCall call){
        try{requirePage();AndroidHostService.requestStop();}
        catch(Exception e){call.reject(e.getMessage(),e);return;}
        run(call,()->{
            long deadline=System.currentTimeMillis()+45000;
            while(AndroidHostService.active()&&System.currentTimeMillis()<deadline)Thread.sleep(100);
            if(AndroidHostService.active())throw new IOException("主机仍在停止，请稍后重试");
            return new JSObject().put("ok",true);
        });
    }
    @Override protected void handleOnDestroy(){localPage=false;worker.shutdown();}
}
