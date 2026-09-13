package com.redvsblue.client;

import org.junit.Test;
import static org.junit.Assert.*;

public class UpdateSourcesTest {
    private final String tag="content-test-"+new String(new char[64]).replace('\0','a');
    private String official(String name){return "https://github.com/longaadream/Red_VS_Blue/releases/download/"+tag+"/"+name;}
    @Test public void sourceSelectionIsClosedAndApkRequiresGithub()throws Exception {
        assertEquals("cos",UpdateSources.validate("cos"));UpdateSources.requireApk("github");
        for(String source:new String[]{null,"other","https://evil.example"}){try{UpdateSources.validate(source);fail();}catch(java.io.IOException expected){}}
        try{UpdateSources.requireApk("cos");fail();}catch(java.io.IOException expected){assertTrue(expected.getMessage().contains("手动切换"));}
    }
    @Test public void mirrorKeepsOfficialIdentityAndFixedVersionDirectory()throws Exception {
        assertEquals(official("content.rvbpack"),UpdateSources.asset("github",tag,"","content.rvbpack",official("content.rvbpack")));
        assertEquals(UpdateSources.COS+"/resource/0.0.1789313922816/content.rvbpack",UpdateSources.asset("cos",tag,"0.0.1789313922816","content.rvbpack",official("content.rvbpack")));
        for(String version:new String[]{"../1","1.2.3/../../x","9007199254740992.0.0"}){try{UpdateSources.asset("cos",tag,version,"content.rvbpack",official("content.rvbpack"));fail();}catch(java.io.IOException expected){}}
        try{UpdateSources.asset("cos",tag,"1.2.3","content.rvbpack","https://evil.example/content.rvbpack");fail();}catch(java.io.IOException expected){}
    }
    @Test public void redirectsCannotLeaveMirrorOrOfficialAssetHosts()throws Exception {
        assertTrue(UpdateSources.redirectAllowed("github","https://release-assets.githubusercontent.com/a?token=abc"));
        assertFalse(UpdateSources.redirectAllowed("cos","https://release-assets.githubusercontent.com/a"));
        for(String target:new String[]{"http://release-assets.githubusercontent.com/a","https://evil.example/a","https://user@release-assets.githubusercontent.com/a","https://release-assets.githubusercontent.com:443/a"})assertFalse(UpdateSources.redirectAllowed("github",target));
    }
    @Test public void checksEveryVersionComponentBeforeComparison()throws Exception {
        assertTrue(UpdateSources.compare("2.0.0","1.9.9")>0);
        try{UpdateSources.compare("2.0.9007199254740992","1.0.0");fail();}catch(java.io.IOException expected){}
    }
}
