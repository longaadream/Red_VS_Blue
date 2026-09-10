package com.redvsblue.client;
import org.junit.Test;
import static org.junit.Assert.*;
import java.util.Set;
public class GamePagePolicyTest {
    private final Set<String> pages=Set.of("index.html","battle.html","android-maintenance.html");
    @Test public void allowsOnlyKnownPackagedDocuments() {
        for(String url:new String[]{"https://localhost/","https://localhost/index.html","https://localhost/battle.html?roomId=abc#turn"}) assertTrue(url,GamePagePolicy.trustedPage(url,pages));
        for(String url:new String[]{"http://localhost/index.html","https://localhost:443/index.html","https://user@localhost/index.html","https://localhost.evil/index.html","https://localhost/missing.html","https://localhost/%69ndex.html","https://localhost/data/../index.html","data:text/html,test","blob:https://localhost/id","javascript:alert(1)"}) assertFalse(url,GamePagePolicy.trustedPage(url,pages));
    }
}
