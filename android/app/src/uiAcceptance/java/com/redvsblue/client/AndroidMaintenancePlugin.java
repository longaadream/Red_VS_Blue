package com.redvsblue.client;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.AtomicFile;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import org.json.*;
import javax.net.ssl.HttpsURLConnection;
import java.net.URL;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;

@CapacitorPlugin(name="AndroidMaintenance")
public class AndroidMaintenancePlugin extends Plugin {
    volatile boolean maintenancePage = false;
    private static final Object STATE_LOCK=new Object();
    private static final Object OPERATION_LOCK=new Object();
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private volatile boolean cancel=false;
    private volatile String progress="";
    private JSONObject pendingUpdate;
    private static boolean operationPending=false;
    private String verifiedActive=null;
    private File root() { File f=new File(getContext().getFilesDir(),"content-v1"); f.mkdirs(); return f; }
    private JSONObject asset(String name) throws Exception { return new JSONObject(new String(ContentFiles.read(getContext().getAssets().open(name),ContentFiles.FILE_LIMIT),StandardCharsets.UTF_8)); }
    private JSONObject config() throws Exception {
        JSONObject config=asset("android-distribution.json");JSONArray keys=config.getJSONArray("trustedPublisherKeyIds");
        for(String key:getContext().getSharedPreferences("content-trust-v1",0).getStringSet("publishers",Collections.emptySet()))keys.put(key);
        return config;
    }
    private JSONObject json(File file) throws Exception { return new JSONObject(new String(ContentFiles.read(new FileInputStream(file),ContentFiles.FILE_LIMIT),StandardCharsets.UTF_8)); }
    private File source(String id) throws Exception { if(id==null||!id.matches("[a-f0-9-]{36}"))throw new IOException("资源引用非法"); return ContentFiles.child(root(),"sources/"+id); }
    private File profile(String id) throws Exception { if(id==null||!id.matches("[a-f0-9]{64}"))throw new IOException("版本引用非法"); return ContentFiles.child(root(),"profiles/"+id); }
    private JSONObject state() throws Exception {
        synchronized(STATE_LOCK){
        AtomicFile file=new AtomicFile(new File(root(),"state.json"));
        if(!file.getBaseFile().exists() && !new File(root(),"state.json.bak").exists()) return new JSONObject().put("schemaVersion",1).put("stable","base").put("previous","base").put("candidate",JSONObject.NULL);
        JSONObject s=new JSONObject(new String(file.readFully(),StandardCharsets.UTF_8));
        if(s.getInt("schemaVersion")!=1)throw new IOException("不支持的资源状态版本"); return s;}
    }
    private void saveState(JSONObject state) throws Exception {
        synchronized(STATE_LOCK){
        requirePage(); AtomicFile file=new AtomicFile(new File(root(),"state.json")); FileOutputStream out=null;
        try { out=file.startWrite(); out.write(state.toString().getBytes(StandardCharsets.UTF_8)); file.finishWrite(out); } catch(Exception e) { if(out!=null)file.failWrite(out); throw e; }}
    }
    private void requirePage() throws IOException { if(!maintenancePage)throw new IOException("请在主菜单的更新与资源页面操作"); }
    void prepareHost() throws Exception {
        synchronized(OPERATION_LOCK){
            if(operationPending)throw new IOException("请等待资源操作完成后开房");
            JSONObject s=state();String stable=s.getString("stable");verifyProfile(stable);
            File host=new File(getContext().getFilesDir(),"android-host");host.mkdirs();
            JSONObject c=new JSONObject().put("stable",stable).put("contentRoot",root().getAbsolutePath()).put("identity",new JSONObject(new String(identityBytes(),StandardCharsets.UTF_8)))
                .put("trustedPublisherKeyIds",config().getJSONArray("trustedPublisherKeyIds")).put("databasePath",new File(host,"authority-v1.sqlite").getAbsolutePath());
            ContentFiles.write(new File(host,"config.json"),c.toString().getBytes(StandardCharsets.UTF_8));
            AndroidHostService.state="starting";
        }
    }
    interface Job { JSObject run() throws Exception; }
    private void run(PluginCall call,Job job) {
        try { requirePage(); synchronized(OPERATION_LOCK){ if(operationPending)throw new IOException("请等待当前操作完成"); operationPending=true; } }
        catch(Exception e){call.reject(e.getMessage());return;}
        try{worker.execute(()->{JSObject result=null;Exception error=null;try{requirePage();result=job.run();}catch(Exception e){error=e;}finally{synchronized(OPERATION_LOCK){operationPending=false;}}if(error==null)call.resolve(result);else call.reject(error.getMessage(),error);});}
        catch(java.util.concurrent.RejectedExecutionException error){synchronized(OPERATION_LOCK){operationPending=false;}call.reject("维护页面已关闭，请重新打开",error);}
    }
    @Override protected void handleOnDestroy(){maintenancePage=false;cancel=true;worker.shutdown();}
    private JSObject obj(JSONObject value) throws JSONException { return new JSObject(value.toString()); }
    private long version(PackageInfo p){return Build.VERSION.SDK_INT>=28?p.getLongVersionCode():p.versionCode;}
    @PluginMethod public void info(PluginCall call) {
        try { requirePage(); PackageInfo p=getContext().getPackageManager().getPackageInfo(getContext().getPackageName(),0);
            call.resolve(new JSObject().put("version",p.versionName).put("versionCode",version(p)).put("packageName",p.packageName).put("state",state()).put("config",config()).put("progress",progress));
        }catch(Exception e){call.reject(e.getMessage(),e);}
    }
    @PluginMethod public void cancel(PluginCall call) { try{requirePage();cancel=true;call.resolve();}catch(Exception e){call.reject(e.getMessage());} }
    @PluginMethod public void trustPublisher(PluginCall call){
        try{requirePage();String key=call.getString("keyId");if(key==null||!key.matches("[a-f0-9]{64}"))throw new IOException("发行者指纹非法");
            getActivity().runOnUiThread(()->{
                if(!maintenancePage){call.reject("页面已关闭");return;}
                new androidx.appcompat.app.AlertDialog.Builder(getActivity()).setTitle("信任此资源包发行者？")
                    .setMessage("包的签名和内容校验已通过，但此发行者未被内置信任。请与资源提供方核对指纹后再允许。\n\n"+key+"\n\n信任后仍禁止资源包执行代码。")
                    .setNegativeButton("取消",(dialog,which)->call.resolve(new JSObject().put("trusted",false)))
                    .setOnCancelListener(dialog->call.resolve(new JSObject().put("trusted",false)))
                    .setPositiveButton("信任此发行者",(dialog,which)->{
                        if(!maintenancePage){call.reject("页面已关闭");return;}
                        Set<String> keys=new HashSet<>(getContext().getSharedPreferences("content-trust-v1",0).getStringSet("publishers",Collections.emptySet()));keys.add(key);
                        boolean saved=getContext().getSharedPreferences("content-trust-v1",0).edit().putStringSet("publishers",keys).commit();
                        if(saved)call.resolve(new JSObject().put("trusted",true));else call.reject("无法保存发行者信任设置");
                    }).show();
            });
        }catch(Exception e){call.reject(e.getMessage(),e);}
    }
    private HttpsURLConnection connect(String address) throws Exception {
        for(int redirects=0;redirects<5;redirects++) {
            URL url=new URL(address); if(!"https".equals(url.getProtocol())||url.getUserInfo()!=null||url.getRef()!=null)throw new IOException("下载地址必须是HTTPS");
            HttpsURLConnection c=(HttpsURLConnection)url.openConnection(); c.setInstanceFollowRedirects(false);c.setConnectTimeout(15000);c.setReadTimeout(15000);
            int code=c.getResponseCode(); if(code>=300&&code<400){String target=c.getHeaderField("Location");c.disconnect();if(target==null)throw new IOException("重定向缺少地址");address=new URL(url,target).toString();continue;}
            if(code!=200){c.disconnect();throw new IOException("下载服务返回HTTP "+code);}return c;
        }throw new IOException("下载重定向过多");
    }
    private void download(String address,File file,long limit) throws Exception {
        HttpsURLConnection c=connect(address);
        try {if(c.getContentLengthLong()>limit)throw new IOException("下载超过大小上限");
            file.getParentFile().mkdirs(); try(InputStream in=c.getInputStream();FileOutputStream out=new FileOutputStream(file)){
                byte[] bytes=new byte[32768];long count=0;int n;while((n=in.read(bytes))!=-1){if(cancel||!maintenancePage)throw new IOException("已取消下载");count+=n;if(count>limit)throw new IOException("下载超过大小上限");out.write(bytes,0,n);progress="已下载 "+(count/1024)+" KiB";}out.getFD().sync();
            }
        }finally{c.disconnect();}
    }
    @PluginMethod public void checkUpdate(PluginCall call) {run(call,()->{
        pendingUpdate=null; String address=config().optString("updateUrl");if(address.isEmpty())throw new IOException("发行者尚未配置更新源，当前可使用本地资源包导入");
        HttpsURLConnection c=connect(address); JSONObject update;
        try{update=new JSONObject(new String(ContentFiles.read(c.getInputStream(),65536),StandardCharsets.UTF_8));}finally{c.disconnect();}
        if(!"rvb-android-update/v1".equals(update.getString("schemaVersion"))||!getContext().getPackageName().equals(update.getString("packageName")))throw new IOException("更新清单与应用不匹配");
        if(!update.getString("sha256").matches("[0-9a-f]{64}")||update.getLong("size")<1||update.getLong("size")>256L*1024*1024||update.getInt("minSdk")>Build.VERSION.SDK_INT)throw new IOException("更新不兼容或清单无效");
        URL url=new URL(update.getString("url"));if(!"https".equals(url.getProtocol())||url.getUserInfo()!=null)throw new IOException("更新地址必须是HTTPS");
        long current=version(getContext().getPackageManager().getPackageInfo(getContext().getPackageName(),0));
        if(update.getLong("versionCode")<=current)return new JSObject().put("available",false);
        pendingUpdate=update;return new JSObject().put("available",true).put("update",update);
    });}
    private File apk(){return new File(getContext().getCacheDir(),"updates/candidate.apk");}
    private Set<String> signatures(PackageInfo p) throws Exception {
        android.content.pm.Signature[] values=Build.VERSION.SDK_INT>=28?p.signingInfo.getApkContentsSigners():p.signatures;
        if(values==null||values.length==0)throw new IOException("APK无有效签名");Set<String> result=new TreeSet<>();for(android.content.pm.Signature s:values)result.add(ContentFiles.hex(s.toByteArray()));return result;
    }
    private void validateApk() throws Exception {
        if(pendingUpdate==null)throw new IOException("请先检查更新");File file=apk();
        if(!file.isFile()||file.length()!=pendingUpdate.getLong("size")||!ContentFiles.hash(file).equals(pendingUpdate.getString("sha256")))throw new IOException("APK完整性校验失败");
        PackageManager pm=getContext().getPackageManager();int flags=Build.VERSION.SDK_INT>=28?PackageManager.GET_SIGNING_CERTIFICATES:PackageManager.GET_SIGNATURES;
        PackageInfo candidate=pm.getPackageArchiveInfo(file.getAbsolutePath(),flags), current=pm.getPackageInfo(getContext().getPackageName(),flags);
        if(candidate==null||!current.packageName.equals(candidate.packageName)||version(candidate)!=pendingUpdate.getLong("versionCode")||version(candidate)<=version(current)||!signatures(current).equals(signatures(candidate)))throw new IOException("APK包名、版本或签名不匹配");
        if(Build.VERSION.SDK_INT>=24 && candidate.applicationInfo!=null && candidate.applicationInfo.minSdkVersion>Build.VERSION.SDK_INT)throw new IOException("APK不兼容当前系统");
    }
    @PluginMethod public void downloadUpdate(PluginCall call){run(call,()->{if(pendingUpdate==null)throw new IOException("请先检查更新");cancel=false;
        File partial=new File(getContext().getCacheDir(),"updates/download.part");try{download(pendingUpdate.getString("url"),partial,pendingUpdate.getLong("size"));
            if(apk().exists()&&!apk().delete())throw new IOException("无法替换下载缓存");if(!partial.renameTo(apk()))throw new IOException("无法保存下载");validateApk();progress="下载校验完成，可以安装";return new JSObject().put("ready",true);
        }finally{if(partial.exists())ContentFiles.remove(getContext().getCacheDir(),partial);}
    });}
    @PluginMethod public void installUpdate(PluginCall call){run(call,()->{if(AndroidHostService.active())throw new IOException("请先停止手机开房，再安装应用更新");validateApk();requirePage();
        getActivity().runOnUiThread(()->{try{
            if(Build.VERSION.SDK_INT>=26&&!getContext().getPackageManager().canRequestPackageInstalls()){
                getActivity().startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:"+getContext().getPackageName())));return;
            }
            Uri uri=FileProvider.getUriForFile(getContext(),getContext().getPackageName()+".fileprovider",apk());
            getActivity().startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(uri,"application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
        }catch(Exception e){progress="无法打开安装器："+e.getMessage();}});
        return new JSObject().put("message","如系统要求，请允许本应用安装软件后再次点安装；取消安装不会清除数据");
    });}
    @PluginMethod public void choosePack(PluginCall call){
        try{requirePage();synchronized(OPERATION_LOCK){if(operationPending)throw new IOException("请等待当前操作完成");}
            Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").putExtra(Intent.EXTRA_MIME_TYPES,new String[]{"application/zip","application/octet-stream","application/x-zip-compressed"});
            startActivityForResult(call,intent,"packChosen");
        }catch(Exception e){call.reject(e.getMessage(),e);}
    }
    @ActivityCallback private void packChosen(PluginCall call,ActivityResult result){if(call==null)return;
        if(result.getResultCode()!=android.app.Activity.RESULT_OK||result.getData()==null||result.getData().getData()==null){call.resolve(new JSObject().put("cancelled",true));return;}
        Uri uri=result.getData().getData();run(call,()->{
            File archive=new File(getContext().getCacheDir(),"pack-import.zip");
            try(InputStream in=getContext().getContentResolver().openInputStream(uri);FileOutputStream out=new FileOutputStream(archive)){if(in==null)throw new IOException("无法读取所选文件");ContentFiles.copy(in,out,ContentFiles.ARCHIVE_LIMIT);}
            try{return extract(archive);}finally{ContentFiles.remove(getContext().getCacheDir(),archive);}
        });
    }
    @PluginMethod public void downloadPack(PluginCall call){run(call,()->{cancel=false;File archive=new File(getContext().getCacheDir(),"pack-download.zip");
        try{download(call.getString("url"),archive,ContentFiles.ARCHIVE_LIMIT);return extract(archive);}finally{if(archive.exists())ContentFiles.remove(getContext().getCacheDir(),archive);}
    });}
    private long diskBytes(File directory){long total=0;File[] list=directory.listFiles();if(list!=null)for(File f:list)total+=f.isDirectory()?diskBytes(f):f.length();return total;}
    private JSObject extract(File archive) throws Exception {
        if(diskBytes(root())>384L*1024*1024)throw new IOException("资源存储空间已满，请恢复内置资源并清理未使用版本");
        String id=UUID.randomUUID().toString();File dir=source(id);dir.mkdirs();
        try{List<String> paths=ContentFiles.unzip(archive,dir);JSONObject index=new JSONObject().put("paths",new JSONArray(paths));ContentFiles.write(new File(dir,".index.json"),index.toString().getBytes(StandardCharsets.UTF_8));return new JSObject().put("id",id);}
        catch(Exception e){ContentFiles.remove(root(),dir);throw e;}
    }
    @PluginMethod public void readSource(PluginCall call){run(call,()->{
        String id=call.getString("id");JSONObject metadata;
        if("base".equals(id))metadata=asset("android-base.json");else{
            File dir=source(id);metadata=json(new File(dir,".index.json"));
            metadata.put("manifest",Base64.encodeToString(ContentFiles.read(new FileInputStream(new File(dir,"manifest.json")),ContentFiles.FILE_LIMIT),Base64.NO_WRAP));
            metadata.put("signature",Base64.encodeToString(ContentFiles.read(new FileInputStream(new File(dir,"signature.json")),ContentFiles.FILE_LIMIT),Base64.NO_WRAP));
        }return obj(metadata);
    });}
    private InputStream sourceFile(String id,String path)throws Exception{
        ContentFiles.path(path);return "base".equals(id)?getContext().getAssets().open("public/"+path):new FileInputStream(ContentFiles.child(source(id),path));
    }
    @PluginMethod public void readSourceFile(PluginCall call){run(call,()->new JSObject().put("base64",Base64.encodeToString(ContentFiles.read(sourceFile(call.getString("id"),call.getString("path")),ContentFiles.FILE_LIMIT),Base64.NO_WRAP)));}
    @PluginMethod public void readProfile(PluginCall call){run(call,()->{
        String id=call.getString("id");return obj("base".equals(id)?asset("android-base-profile.json"):json(new File(profile(id),"record.json")));
    });}
    @PluginMethod public void discardSource(PluginCall call){run(call,()->{
        String id=call.getString("id");File profiles=new File(root(),"profiles");File[] list=profiles.listFiles();
        if(list!=null)for(File p:list)if(new File(p,"record.json").isFile()&&json(new File(p,"record.json")).getJSONArray("chain").toString().contains(id))throw new IOException("资源仍被已安装版本使用");
        ContentFiles.remove(root(),source(id));return new JSObject();
    });}
    @PluginMethod public void commitCandidate(PluginCall call){run(call,()->{
        JSONObject record=call.getObject("record"), content=record.getJSONObject("profile"), origins=record.getJSONObject("sources");
        String hash=content.getString("resolvedProfileHash");File destination=profile(hash);JSONArray files=content.getJSONArray("files");
        if(files.length()>2048||diskBytes(root())>384L*1024*1024)throw new IOException("资源存储超过上限");
        File stage=ContentFiles.child(root(),"staging/"+UUID.randomUUID());stage.mkdirs();
        try{
            long total=0;Set<String> paths=new HashSet<>();JSONObject battleFiles=new JSONObject();
            for(int i=0;i<files.length();i++){
                JSONObject entry=files.getJSONObject(i), descriptor=entry.getJSONObject("descriptor"), provenance=entry.getJSONObject("provenance");String target=descriptor.getString("path");
                if(!target.matches("(?:data/.+\\.json|images/.+\\.(?:png|jpg|jpeg|webp|svg))")||!paths.add(target.toLowerCase(Locale.ROOT)))throw new IOException("不可启用此资源路径");
                String sourceId=origins.getString(provenance.getString("packageHash"));File output=ContentFiles.child(stage,target);output.getParentFile().mkdirs();
                try(InputStream in=sourceFile(sourceId,provenance.getString("sourcePath"));FileOutputStream out=new FileOutputStream(output)){total+=ContentFiles.copy(in,out,Math.min(ContentFiles.FILE_LIMIT,ContentFiles.TOTAL_LIMIT-total));out.getFD().sync();}
                if(output.length()!=descriptor.getLong("size")||!ContentFiles.hash(output).equals(descriptor.getString("sha256")))throw new IOException("写入后资源校验失败");
                if(target.matches("data/(?:cards|maps|pieces|rules|skills|status-effects|tiles)/.+\\.json")||target.equals("data/skill-keywords.json")||target.equals("data/tutorial/first-session.json")){
                    battleFiles.put(target,new JSONTokener(new String(ContentFiles.read(new FileInputStream(output),ContentFiles.FILE_LIMIT),StandardCharsets.UTF_8)).nextValue());
                }
            }
            ContentFiles.write(new File(stage,"record.json"),record.toString().getBytes(StandardCharsets.UTF_8));
            ContentFiles.write(new File(stage,"__battle-data.json"),new JSONObject().put("schemaVersion","rvb-client-battle-data/v1").put("files",battleFiles).toString().getBytes(StandardCharsets.UTF_8));
            JSONObject identity=asset("public/__tutorial-profile.json");identity.put("resolvedProfileHash",hash).put("authorityContentHash",content.getString("authorityContentHash")).put("engineAbi",content.getJSONObject("compatibility").getString("engineAbi"));
            ContentFiles.write(new File(stage,"__tutorial-profile.json"),identity.toString().getBytes(StandardCharsets.UTF_8));
            requirePage();destination.getParentFile().mkdirs();if(destination.exists())verifyProfile(hash);else if(!stage.renameTo(destination))throw new IOException("无法保存候选版本");
            JSONObject s=state();s.put("candidate",hash);saveState(s);return new JSObject().put("hash",hash);
        }finally{if(stage.exists())ContentFiles.remove(root(),stage);}
    });}
    private void verifyProfile(String id)throws Exception{
        if("base".equals(id))return;JSONObject record=json(new File(profile(id),"record.json"));JSONArray entries=record.getJSONObject("profile").getJSONArray("files");
        JSONObject bundled=asset("android-base-profile.json").getJSONObject("profile"),installed=record.getJSONObject("profile");
        JSONObject expected=bundled.getJSONObject("compatibility"),actual=installed.getJSONObject("compatibility");
        if(!id.equals(installed.getString("resolvedProfileHash"))||!expected.getString("engineAbi").equals(actual.getString("engineAbi"))||!expected.getString("contentAbi").equals(actual.getString("contentAbi")))throw new IOException("此资源版本需要兼容的应用版本，请恢复内置资源");
        if(record.getJSONArray("chain").getString(0).equals("base")&&!bundled.getJSONObject("base").getString("packageHash").equals(installed.getJSONObject("base").getString("packageHash")))throw new IOException("游戏内置内容已更新，请恢复内置资源并重新导入对应补丁");
        for(int i=0;i<entries.length();i++){JSONObject d=entries.getJSONObject(i).getJSONObject("descriptor");File f=ContentFiles.child(profile(id),d.getString("path"));if(!f.isFile()||f.length()!=d.getLong("size")||!ContentFiles.hash(f).equals(d.getString("sha256")))throw new IOException("已安装资源损坏，请恢复内置资源");}
    }
    @PluginMethod public void activate(PluginCall call){run(call,()->{
        if(AndroidHostService.active())throw new IOException("请先停止手机开房，再切换资源版本");
        JSONObject s=state();String target=call.getString("target"),id;
        if("base".equals(target))id="base";else if("previous".equals(target))id=s.getString("previous");else if("candidate".equals(target)&&!s.isNull("candidate"))id=s.getString("candidate");else throw new IOException("没有可切换的版本");
        verifyProfile(id);requirePage();if(!id.equals(s.getString("stable")))s.put("previous",s.getString("stable"));s.put("stable",id).put("candidate",JSONObject.NULL);saveState(s);
        return new JSObject().put("stable",id);
    });}
    @PluginMethod public void cleanUnused(PluginCall call){run(call,()->{
        File abandoned=new File(root(),"staging");if(abandoned.exists())ContentFiles.remove(root(),abandoned);
        JSONObject s=state();Set<String> keepProfiles=new HashSet<>(),keepSources=new HashSet<>();for(String key:new String[]{"stable","previous","candidate"})if(!s.isNull(key)&&!"base".equals(s.optString(key)))keepProfiles.add(s.getString(key));
        File profiles=new File(root(),"profiles");File[] list=profiles.listFiles();if(list!=null)for(File dir:list){if(keepProfiles.contains(dir.getName())){JSONArray chain=json(new File(dir,"record.json")).getJSONArray("chain");for(int i=0;i<chain.length();i++)keepSources.add(chain.getString(i));}else ContentFiles.remove(root(),dir);}
        list=new File(root(),"sources").listFiles();if(list!=null)for(File dir:list)if(!keepSources.contains(dir.getName()))ContentFiles.remove(root(),dir);
        return new JSObject();
    });}
    byte[] identityBytes()throws Exception{
        JSONObject identity=asset("public/__tutorial-profile.json");String id=state().getString("stable");
        if(!"base".equals(id)){
            synchronized(this){if(!id.equals(verifiedActive)){verifyProfile(id);verifiedActive=id;}}
            JSONObject p=json(new File(profile(id),"record.json")).getJSONObject("profile");
            identity.put("resolvedProfileHash",p.getString("resolvedProfileHash")).put("authorityContentHash",p.getString("authorityContentHash"));
        }
        return identity.toString().getBytes(StandardCharsets.UTF_8);
    }
    /** Called only by the app's local WebView resource loader. Missing Profile-owned data must not fall back to Base. */
    File activeFile(String path)throws Exception{
        if(!path.equals("__battle-data.json")&&!path.equals("__tutorial-profile.json")&&!path.startsWith("data/")&&!path.startsWith("images/"))return null;
        String id=state().getString("stable");if("base".equals(id))return null;
        synchronized(this){if(!id.equals(verifiedActive)){verifyProfile(id);verifiedActive=id;}}
        File directory=profile(id);
        if(path.equals("__battle-data.json")||path.equals("__tutorial-profile.json"))return ContentFiles.child(directory,path);
        if(path.startsWith("data/")&&path.endsWith(".json"))return ContentFiles.child(directory,path);
        if(path.startsWith("images/")){
            JSONArray entries=json(new File(directory,"record.json")).getJSONObject("profile").getJSONArray("files");
            for(int i=0;i<entries.length();i++)if(path.equals(entries.getJSONObject(i).getJSONObject("descriptor").getString("path")))return ContentFiles.child(directory,path);
        }return null;
    }
}
