package com.redvsblue.client;

import android.app.*;
import android.content.*;
import android.os.*;
import androidx.core.app.NotificationCompat;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

/** Owns the real Colyseus child process independently of the visible WebView. */
public class AndroidHostService extends Service {
    static final Object LOCK = new Object();
    static volatile String state = "stopped", error = "";
    static volatile JSONObject ready;
    static boolean cancelPendingStart;
    private static volatile AndroidHostService owner;
    private final ExecutorService lifecycle = Executors.newSingleThreadExecutor();
    private final ConcurrentHashMap<String,CompletableFuture<JSONObject>> requests = new ConcurrentHashMap<>();
    private volatile java.lang.Process runtime;
    private volatile boolean stopping, stopRequested, destroyed, cleaned, stopFailed;
    private PowerManager.WakeLock wake;
    static boolean active() { return owner!=null || (!"stopped".equals(state) && !"failed".equals(state)); }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public int onStartCommand(Intent intent,int flags,int id) {
        if(intent!=null && "stop".equals(intent.getAction())) { requestStop(); if(owner==null)stopSelf(); return START_NOT_STICKY; }
        synchronized(LOCK) {
            if(owner!=null){if(owner!=this)stopSelf();return START_NOT_STICKY;}
            owner=this;stopRequested=cancelPendingStart; state=stopRequested?"stopping":"starting"; error=""; ready=null;
        }
        notification("正在启动手机主机…");
        wake=((PowerManager)getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"RVB:ColyseusHost");
        wake.setReferenceCounted(false); wake.acquire(6*60*60*1000L);
        lifecycle.execute(this::startRuntime);
        return START_NOT_STICKY;
    }
    private void notification(String text) {
        NotificationManager manager=(NotificationManager)getSystemService(NOTIFICATION_SERVICE);
        if(Build.VERSION.SDK_INT>=26)manager.createNotificationChannel(new NotificationChannel("rvb-host","联机房主运行",NotificationManager.IMPORTANCE_LOW));
        PendingIntent open=PendingIntent.getActivity(this,0,new Intent(this,UiAcceptanceActivity.class),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop=PendingIntent.getService(this,1,new Intent(this,AndroidHostService.class).setAction("stop"),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        Notification n=new NotificationCompat.Builder(this,"rvb-host").setSmallIcon(android.R.drawable.stat_notify_sync).setContentTitle("红蓝对决 · 手机主机")
            .setContentText(text).setContentIntent(open).setOngoing(true).addAction(0,"停止开房",stop).build();
        if(Build.VERSION.SDK_INT>=34)startForeground(199,n,android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);else startForeground(199,n);
    }
    private void startRuntime() {
        try {
            checkStarting();
            File host=new File(getFilesDir(),"android-host");host.mkdirs();
            // This directory contains only APK-derived files. Rebuild it so an
            // upgrade cannot retain deleted JSON entries in the base Profile.
            File previous=new File(host,"bundle");if(previous.exists())ContentFiles.remove(host,previous);
            File installed=new File(host,"bundle");installed.mkdirs();
            JSONObject manifest=new JSONObject(new String(ContentFiles.read(getAssets().open("host-files.json"),ContentFiles.FILE_LIMIT),StandardCharsets.UTF_8));
            JSONArray files=manifest.getJSONArray("files");
            String abi=Build.SUPPORTED_ABIS[0];
            if(!abi.equals("arm64-v8a")&&!abi.equals("x86_64"))throw new IOException("此候选需要64位安卓设备");
            for(int i=0;i<files.length();i++) {
                checkStarting();
                JSONObject f=files.getJSONObject(i);String name=f.getString("path");
                if(name.startsWith("host-runtime/")&&!name.startsWith("host-runtime/"+abi+"/"))continue;
                File target=ContentFiles.child(installed,name);target.getParentFile().mkdirs();
                if(target.isFile()&&target.length()==f.getLong("size")&&ContentFiles.hash(target).equals(f.getString("sha256")))continue;
                target.setWritable(true,true);
                try(InputStream in=getAssets().open(name);FileOutputStream out=new FileOutputStream(target)){ContentFiles.copy(in,out,f.getLong("size"));out.getFD().sync();}
                if(!ContentFiles.hash(target).equals(f.getString("sha256")))throw new IOException("主机文件校验失败："+name);
                target.setWritable(false,false);
            }
            File session=new File(host,"session");if(session.exists())ContentFiles.remove(host,session);session.mkdirs();
            String libraries=new File(installed,"host-runtime/"+abi+"/lib").getAbsolutePath();
            ProcessBuilder builder=new ProcessBuilder(new File(getApplicationInfo().nativeLibraryDir,"librvb_node.so").getAbsolutePath(),new File(installed,"host-code/server.mjs").getAbsolutePath());
            builder.directory(installed);builder.redirectErrorStream(true);
            Map<String,String> env=builder.environment();env.put("LD_LIBRARY_PATH",libraries);env.put("APP_ROOT_DIR",new File(installed,"host-base").getAbsolutePath());
            env.put("USER_DATA_DIR",session.getAbsolutePath());env.put("RVB_ANDROID_HOST_CONFIG",new File(host,"config.json").getAbsolutePath());
            env.put("NODE_EXTRA_CA_CERTS",new File(installed,"host-runtime/"+abi+"/cert.pem").getAbsolutePath());
            env.put("NODE_ENV","production");env.put("TMPDIR",getCacheDir().getAbsolutePath());
            synchronized(LOCK){checkStarting();runtime=builder.start();}
            Thread reader=new Thread(()->readOutput(host),"RVB-Colyseus-output");reader.start();
            long until=System.currentTimeMillis()+90000;
            while(!stopRequested&&"starting".equals(state)&&System.currentTimeMillis()<until&&runtime.isAlive())Thread.sleep(100);
            checkStarting();
            if(!"running".equals(state))throw new IOException(error.isEmpty()?"手机主机启动超时，请查看主机日志":error);
            notification("对局运行中 · 切到后台仍保持联机");
        } catch(Exception e) { if(!stopRequested)fail(e); stopRuntime(); }
    }
    private void checkStarting()throws IOException {if(stopRequested||owner!=this)throw new IOException("主机启动已取消");}
    static void requestStop(){
        synchronized(LOCK){
            AndroidHostService service=owner;
            if(service==null){if("starting".equals(state)){cancelPendingStart=true;state="stopping";}return;}
            service.stopRequested=true;
            if(!"failed".equals(state))state="stopping";
            if(!service.lifecycle.isShutdown())service.lifecycle.execute(service::stopRuntime);
        }
    }
    private void readOutput(File host) {
        try(BufferedReader in=new BufferedReader(new InputStreamReader(runtime.getInputStream(),StandardCharsets.UTF_8));FileOutputStream log=new FileOutputStream(new File(host,"last-start.log"))) {
            String line;long bytes=0;
            while((line=in.readLine())!=null) {
                byte[] entry=(line+"\n").getBytes(StandardCharsets.UTF_8);if(bytes<2*1024*1024){log.write(entry);bytes+=entry.length;}
                if(!line.startsWith("RVB_HOST "))continue;
                JSONObject packet=new JSONObject(line.substring(9));String type=packet.optString("type");
                synchronized(LOCK){
                    if(owner==this&&!stopRequested){
                        if(type.equals("ready")){ready=packet;state="running";}
                        if(type.equals("failed")){error=packet.optString("error");state="failed";}
                    }
                }
                if(type.equals("reply")){CompletableFuture<JSONObject> pending=requests.remove(packet.optString("id"));if(pending!=null)pending.complete(packet);}
            }
        } catch(Exception e) { if(!stopRequested)fail(e); }
        finally { synchronized(LOCK){if(owner==this&&!stopRequested){fail(new IOException(error.isEmpty()?"手机主机已停止，当前对局连接中断":error));requestStop();}} }
    }
    static JSONObject control(JSONObject request)throws Exception {
        AndroidHostService service=owner;
        if(service==null||service.runtime==null||!service.runtime.isAlive())throw new IOException("手机主机未运行");
        String id=UUID.randomUUID().toString();request.put("id",id);CompletableFuture<JSONObject> result=new CompletableFuture<>();service.requests.put(id,result);
        try {
            synchronized(service.runtime){OutputStream out=service.runtime.getOutputStream();out.write((request.toString()+"\n").getBytes(StandardCharsets.UTF_8));out.flush();}
            return result.get(35,TimeUnit.SECONDS);
        }finally{service.requests.remove(id);}
    }
    private void fail(Exception e){synchronized(LOCK){if(owner!=this)return;error=e.getMessage();state="failed";}android.util.Log.e("RVBHost",error,e);}
    private void stopRuntime() {
        synchronized(LOCK){if(stopping||owner!=this)return;stopping=true;stopRequested=true;}
        boolean failed="failed".equals(state);if(!failed)state="stopping";
        try { if(runtime!=null&&runtime.isAlive()&&ready!=null){JSONObject result=control(new JSONObject().put("action","shutdown"));if(!result.optBoolean("ok"))throw new IOException(result.optString("error"));runtime.waitFor(5,TimeUnit.SECONDS);} }
        catch(Exception e){fail(e);failed=true;}
        finally {
            if(runtime!=null&&runtime.isAlive()){
                runtime.destroyForcibly();
                boolean interrupted=false;
                while(runtime.isAlive()){try{runtime.waitFor();}catch(InterruptedException e){interrupted=true;}}
                if(interrupted)Thread.currentThread().interrupt();
            }
            runtime=null;
            for(CompletableFuture<JSONObject> request:requests.values())request.completeExceptionally(new IOException("主机停止"));requests.clear();
            if(wake!=null&&wake.isHeld())wake.release();wake=null;
            synchronized(LOCK){ready=null;stopFailed=failed;cleaned=true;releaseDestroyedOwner();}
            stopForeground(STOP_FOREGROUND_REMOVE);stopSelf();
        }
    }
    private void releaseDestroyedOwner(){
        if(owner==this&&cleaned&&destroyed){owner=null;state=stopFailed?"failed":"stopped";}
    }
    @Override public void onDestroy(){
        // Revoke this instance before its output reader can publish another
        // ready event. Keep ownership until the child has actually exited.
        synchronized(LOCK){destroyed=true;if(owner==this)requestStop();releaseDestroyedOwner();}
        if(runtime!=null&&runtime.isAlive())runtime.destroyForcibly();
        lifecycle.shutdown();super.onDestroy();
    }
}
