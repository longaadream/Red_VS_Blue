package com.redvsblue.client;

import java.io.IOException;
import java.net.URL;

/** Fixed distribution endpoints; selecting a mirror never changes publisher trust. */
final class UpdateSources {
    static final String COS="https://rvb-updates-hk-1321590994.cos.ap-hongkong.myqcloud.com";
    static final String REPOSITORY="longaadream/Red_VS_Blue";
    static String validate(String source)throws IOException {
        if(!"github".equals(source)&&!"cos".equals(source))throw new IOException("请选择 GitHub 或 COS 下载源");
        return source;
    }
    static void requireApk(String source)throws IOException {
        if("cos".equals(validate(source)))throw new IOException("COS 默认域名暂不支持安卓 APK，请手动切换到 GitHub 后检查更新；资源包仍可使用 COS");
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
