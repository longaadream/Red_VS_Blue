package com.redvsblue.client;

import java.io.IOException;
import java.net.URL;

/** Fixed distribution endpoints; selecting a mirror never changes publisher trust. */
final class UpdateSources {
    static final String COS="https://updates.redvsblue.top";
    static final String REPOSITORY="longaadream/Red_VS_Blue";
    static String validate(String source)throws IOException {
        if(!"github".equals(source)&&!"cos".equals(source))throw new IOException("请选择 GitHub 或 COS 下载源");
        return source;
    }
    static String apkManifest(String source,String configured)throws IOException {
        return "cos".equals(validate(source))?COS+"/android-latest.json":configured;
    }
    static String apkAsset(String source,String version,String official)throws IOException {
        validate(source);
        if("github".equals(source))return official;
        if(version==null||!version.matches("[0-9]+\\.[0-9]+\\.[0-9]+(?:-demo)?"))throw new IOException("APK版本无效");
        String release=version.replaceFirst("-demo$", "");
        String prefix="https://github.com/"+REPOSITORY+"/releases/download/v"+release+"/";
        if(!official.startsWith(prefix))throw new IOException("APK发行地址无效");
        String name=official.substring(prefix.length());
        if(!name.equals("RED-vs-BLUE-"+release+"-Android.apk")&&!name.matches("RED-vs-BLUE-Android-[0-9]+-to-[0-9]+\\.rvbdelta"))throw new IOException("APK文件身份无效");
        return COS+"/"+release+"/"+name;
    }
    static int compare(String a,String b)throws IOException {
        if(a==null||b==null||!a.matches("[0-9]+\\.[0-9]+\\.[0-9]+")||!b.matches("[0-9]+\\.[0-9]+\\.[0-9]+"))throw new IOException("资源版本格式无效");
        String[] left=a.split("\\."),right=b.split("\\.");
        try{long[] x=new long[3],y=new long[3];for(int i=0;i<3;i++){x[i]=Long.parseLong(left[i]);y[i]=Long.parseLong(right[i]);if(x[i]>9007199254740991L||y[i]>9007199254740991L)throw new NumberFormatException();}for(int i=0;i<3;i++){int c=Long.compare(x[i],y[i]);if(c!=0)return c;}return 0;}
        catch(NumberFormatException e){throw new IOException("资源版本超出范围",e);}
    }
    static String asset(String source,String tag,String version,String name,String official)throws Exception {
        validate(source);
        if(!tag.matches("content-test-[a-f0-9]{64}")||!name.matches("content(?:-update\\.json|(?:-patch)?\\.rvbpack)"))throw new IOException("官方资源文件身份无效");
        String expected="https://github.com/"+REPOSITORY+"/releases/download/"+tag+"/"+name;
        if(!expected.equals(official))throw new IOException("官方资源下载地址无效");
        if("github".equals(source))return expected;
        compare(version,version);
        return COS+"/resource/"+version+"/"+name;
    }
    static boolean redirectAllowed(String source,String target)throws Exception {
        URL u=new URL(target);
        if(!"https".equals(u.getProtocol())||u.getPort()!=-1||u.getUserInfo()!=null||u.getRef()!=null)return false;
        if("cos".equals(source))return false;
        return "release-assets.githubusercontent.com".equals(u.getHost())||"objects.githubusercontent.com".equals(u.getHost());
    }
}
