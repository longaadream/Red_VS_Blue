package com.redvsblue.client;

import com.getcapacitor.BridgeActivity;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

/** Isolated UI acceptance shell. No legacy mobile host or resource-pack bridge. */
public class UiAcceptanceActivity extends BridgeActivity {
    @Override public void onCreate(Bundle state) {
        registerPlugin(AndroidMaintenancePlugin.class);
        registerPlugin(AndroidHostPlugin.class);
        super.onCreate(state);
        final java.util.Set<String> pages = new java.util.HashSet<>();
        try { for (String name : getAssets().list("public")) if (name.endsWith(".html")) pages.add(name); }
        catch (java.io.IOException error) { throw new IllegalStateException("Missing game pages", error); }
        bridge.getWebView().setWebViewClient(new com.getcapacitor.BridgeWebViewClient(bridge) {
            @Override public boolean shouldOverrideUrlLoading(android.webkit.WebView view, android.webkit.WebResourceRequest request) {
                return !GamePagePolicy.trustedPage(request.getUrl().toString(), pages);
            }
            @Override public boolean shouldOverrideUrlLoading(android.webkit.WebView view, String url) {
                return !GamePagePolicy.trustedPage(url, pages);
            }
            @Override public void onPageStarted(android.webkit.WebView view, String url, android.graphics.Bitmap favicon) {
                boolean trusted = GamePagePolicy.trustedPage(url, pages);
                // LAN Colyseus uses HTTP/WS. Only packaged game documents may
                // connect; CSP below still refuses remote executable content.
                view.getSettings().setMixedContentMode(trusted ? android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW : android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
                ((AndroidMaintenancePlugin)bridge.getPlugin("AndroidMaintenance").getInstance()).maintenancePage = "https://localhost/android-maintenance.html".equals(url);
                ((AndroidHostPlugin)bridge.getPlugin("AndroidHost").getInstance()).localPage=trusted;
                if (!trusted) { view.stopLoading(); return; }
                super.onPageStarted(view, url, favicon);
            }
            @Override public android.webkit.WebResourceResponse shouldInterceptRequest(android.webkit.WebView view, android.webkit.WebResourceRequest request) {
                android.net.Uri uri=request.getUrl();
                if ("https".equals(uri.getScheme()) && "localhost".equals(uri.getHost()) && !GamePagePolicy.localOrigin(uri.toString())) return null;
                if (GamePagePolicy.localOrigin(uri.toString())) {
                    String path=uri.getPath().substring(1);
                    if(!request.isForMainFrame() && path.endsWith(".html")) return response(403,"text/plain",new byte[0]);
                    try {
                        AndroidMaintenancePlugin plugin=(AndroidMaintenancePlugin)bridge.getPlugin("AndroidMaintenance").getInstance();
                        if(path.equals("__tutorial-profile.json"))return response(200,"application/json",plugin.identityBytes());
                        java.io.File file=plugin.activeFile(path);
                        if(file!=null){
                            if(!file.isFile())return response(404,"text/plain",new byte[0]);
                            String mime=path.endsWith(".json")?"application/json":android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(android.webkit.MimeTypeMap.getFileExtensionFromUrl(path));
                            android.webkit.WebResourceResponse result=new android.webkit.WebResourceResponse(mime==null?"application/octet-stream":mime,"UTF-8",new java.io.FileInputStream(file));
                            java.util.Map<String,String> headers=new java.util.HashMap<>();headers.put("Cache-Control","no-store");headers.put("X-Content-Type-Options","nosniff");result.setResponseHeaders(headers);return result;
                        }
                    }catch(Exception error){android.util.Log.e("RVBContent","Profile read failed: "+path,error);return response(503,"text/plain","资源读取失败，请到资源管理恢复内置资源".getBytes(java.nio.charset.StandardCharsets.UTF_8));}
                }
                android.webkit.WebResourceResponse result=super.shouldInterceptRequest(view,request);
                if(result!=null && request.isForMainFrame()) {
                    java.util.Map<String,String> headers=new java.util.HashMap<>();if(result.getResponseHeaders()!=null)headers.putAll(result.getResponseHeaders());
                    headers.put("Content-Security-Policy",GamePagePolicy.CSP);result.setResponseHeaders(headers);
                }
                return result;
            }
            private android.webkit.WebResourceResponse response(int status,String mime,byte[] bytes){return new android.webkit.WebResourceResponse(mime,"UTF-8",status,"Resource",java.util.Collections.singletonMap("Cache-Control","no-store"),new java.io.ByteArrayInputStream(bytes));}
        });
        getWindow().setBackgroundDrawable(new ColorDrawable(Color.rgb(48, 37, 30)));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams attributes = getWindow().getAttributes();
            attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(attributes);
        }
        enterFullscreen();
    }

    private void enterFullscreen() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        controller.hide(WindowInsetsCompat.Type.systemBars());
    }

    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused) enterFullscreen();
    }
}
