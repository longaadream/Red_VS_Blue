package com.redvsblue.client;

import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.AssetManager;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.net.http.SslError;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.WebViewCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.FileNotFoundException;
import java.net.Inet4Address;
import java.net.NetworkInterface;
import java.util.Collections;
import java.util.Enumeration;
import java.util.concurrent.CountDownLatch;

public class MainActivity extends BridgeActivity {

    private static final String PREFS      = "rvb_prefs";
    private static final String KEY_URL    = "server_url";
    private static final String KEY_IMPORT_URI = "import_uri";

    // ── Mobile LAN server ─────────────────────────────────────────────────────
    private static final int MOBILE_SERVER_PORT = 7878;
    private static final int DISCOVERY_PORT     = 7877;
    private GameEngineWebView gameEngineWebView = null;
    private MobileHttpServer  mobileHttpServer  = null;
    private boolean           serverStarting    = false;
    private boolean           engineWarming     = false;

    // ── UDP host broadcast ────────────────────────────────────────────────────
    private Thread            broadcastThread   = null;
    private volatile boolean  broadcastRunning  = false;

    private void stopHostBroadcastInternal() {
        broadcastRunning = false;
        if (broadcastThread != null) { broadcastThread.interrupt(); broadcastThread = null; }
    }

    /** Returns device's first non-loopback IPv4 address, or empty string. */
    private String getLocalIpAddress() {
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            for (NetworkInterface ni : Collections.list(ifaces)) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                Enumeration<java.net.InetAddress> addrs = ni.getInetAddresses();
                for (java.net.InetAddress addr : Collections.list(addrs)) {
                    if (!addr.isLoopbackAddress() && addr instanceof Inet4Address) {
                        return addr.getHostAddress();
                    }
                }
            }
        } catch (Exception ignored) {}
        return "";
    }

    public class RvBBridge {
        @JavascriptInterface
        public String getSavedUrl() {
            return getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_URL, "");
        }

        @JavascriptInterface
        public void saveUrl(String url) {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_URL, url).apply();
        }

        @JavascriptInterface
        public void saveAndNavigate(String url) {
            saveUrl(url);
        }

        @JavascriptInterface
        public void clearUrl() {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(KEY_URL).apply();
        }

        @JavascriptInterface
        public String getAndClearImportUri() {
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            String uri = prefs.getString(KEY_IMPORT_URI, null);
            if (uri != null) {
                prefs.edit().remove(KEY_IMPORT_URI).apply();
            }
            return uri != null ? uri : "";
        }

        // ── LAN host server ───────────────────────────────────────────────────

        @JavascriptInterface
        public String startMobileServer() {
            if (mobileHttpServer != null && mobileHttpServer.isAlive()) {
                getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                    .putString(KEY_URL, "http://localhost:" + MOBILE_SERVER_PORT)
                    .apply();
                return getMobileServerStatus();
            }
            if (serverStarting) return "{\"ok\":false,\"starting\":true,\"running\":false}";
            serverStarting = true;
            // 在后台线程初始化（waitForReady 最多 15 秒），完成后通过 JS 回调通知
            new Thread(() -> {
                try {
                    GameEngineWebView engine = gameEngineWebView;
                    if (engine == null) {
                        final GameEngineWebView[] holder = { null };
                        final CountDownLatch uiLatch = new CountDownLatch(1);
                        runOnUiThread(() -> {
                            holder[0] = new GameEngineWebView(MainActivity.this);
                            gameEngineWebView = holder[0];
                            uiLatch.countDown();
                        });
                        if (!uiLatch.await(5, java.util.concurrent.TimeUnit.SECONDS)) {
                            serverStarting = false;
                            fireServerReady("{\"ok\":false,\"error\":\"UI init timeout\",\"running\":false}");
                            return;
                        }
                        engine = holder[0];
                    }
                    if (!engine.waitForReady(60)) {
                        final GameEngineWebView failedEngine = engine;
                        runOnUiThread(() -> failedEngine.destroy());
                        if (gameEngineWebView == engine) gameEngineWebView = null;
                        serverStarting = false;
                        fireServerReady("{\"ok\":false,\"error\":\"游戏引擎初始化超时（60秒）\",\"running\":false}");
                        return;
                    }
                    MobileHttpServer server = new MobileHttpServer(MOBILE_SERVER_PORT, engine);
                    gameEngineWebView = engine;
                    mobileHttpServer  = server;
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                        .putString(KEY_URL, "http://localhost:" + MOBILE_SERVER_PORT)
                        .apply();
                    serverStarting = false;
                    fireServerReady(getMobileServerStatus());
                } catch (Exception e) {
                    serverStarting = false;
                    String msg = e.getMessage() != null ? e.getMessage().replace("\"","'") : "unknown";
                    fireServerReady("{\"ok\":false,\"error\":\"" + msg + "\",\"running\":false}");
                }
            }).start();
            return "{\"ok\":false,\"starting\":true,\"running\":false}";
        }

        private void warmUpMobileServerEngine() {
            if (gameEngineWebView != null || engineWarming) return;
            engineWarming = true;
            new Thread(() -> {
                try {
                    final GameEngineWebView[] holder = { null };
                    final CountDownLatch uiLatch = new CountDownLatch(1);
                    runOnUiThread(() -> {
                        if (gameEngineWebView == null) {
                            gameEngineWebView = new GameEngineWebView(MainActivity.this);
                        }
                        holder[0] = gameEngineWebView;
                        uiLatch.countDown();
                    });
                    if (uiLatch.await(5, java.util.concurrent.TimeUnit.SECONDS) && holder[0] != null) {
                        holder[0].waitForReady(60);
                    }
                } catch (Exception ignored) {
                } finally {
                    engineWarming = false;
                }
            }).start();
        }

        private void fireServerReady(String json) {
            runOnUiThread(() -> getBridge().getWebView()
                .evaluateJavascript("window._onMobileServerReady&&window._onMobileServerReady(" + json + ")", null));
        }

        @JavascriptInterface
        public String stopMobileServer() {
            stopHostBroadcastInternal();
            try {
                engineWarming = false;
                serverStarting = false;
                if (mobileHttpServer != null) { mobileHttpServer.stop(); mobileHttpServer = null; }
                if (gameEngineWebView != null) { gameEngineWebView.destroy(); gameEngineWebView = null; }
            } catch (Exception ignored) {}
            return "{\"ok\":true}";
        }

        // ── UDP LAN discovery ─────────────────────────────────────────────────

        @JavascriptInterface
        public String startHostBroadcast() {
            stopHostBroadcastInternal();
            final String myIp = getLocalIpAddress();
            final String model = android.os.Build.MODEL.replace("\"", "'");
            final String payload = "{\"magic\":\"RVB_DISCOVER\",\"name\":\"" + model
                    + "\",\"ip\":\"" + myIp + "\",\"port\":" + MOBILE_SERVER_PORT + "}";
            // 获取 MulticastLock（广播收发在部分 Android WiFi 驱动上需要此锁）
            WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            final WifiManager.MulticastLock mcastLock = wifi.createMulticastLock("rvb-broadcast");
            mcastLock.setReferenceCounted(false);
            mcastLock.acquire();
            broadcastRunning = true;
            broadcastThread = new Thread(() -> {
                try {
                    while (broadcastRunning) {
                        try {
                            java.net.DatagramSocket sock = new java.net.DatagramSocket();
                            sock.setBroadcast(true);
                            byte[] data = payload.getBytes("UTF-8");
                            String[] targets = { "255.255.255.255" };
                            if (!myIp.isEmpty()) {
                                int lastDot = myIp.lastIndexOf('.');
                                if (lastDot > 0) targets = new String[]{ myIp.substring(0, lastDot + 1) + "255", "255.255.255.255" };
                            }
                            for (String t : targets) {
                                java.net.DatagramPacket pkt = new java.net.DatagramPacket(
                                    data, data.length, java.net.InetAddress.getByName(t), DISCOVERY_PORT);
                                sock.send(pkt);
                            }
                            sock.close();
                        } catch (Exception ignored) {}
                        try { Thread.sleep(2000); } catch (InterruptedException e) { break; }
                    }
                } finally {
                    try { mcastLock.release(); } catch (Exception ignored) {}
                }
            });
            broadcastThread.setDaemon(true);
            broadcastThread.start();
            return "{\"ok\":true}";
        }

        @JavascriptInterface
        public String stopHostBroadcast() {
            stopHostBroadcastInternal();
            return "{\"ok\":true}";
        }

        @JavascriptInterface
        public void discoverHosts(int timeoutMs) {
            final int timeout = timeoutMs > 0 ? timeoutMs : 3000;
            // MulticastLock：让 WiFi 驱动不过滤广播/组播包
            WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            final WifiManager.MulticastLock lock = wifi.createMulticastLock("rvb-discover");
            lock.setReferenceCounted(false);
            lock.acquire();
            new Thread(() -> {
                java.util.Set<String> seen = new java.util.HashSet<>();
                try {
                    java.net.DatagramSocket sock = new java.net.DatagramSocket(null);
                    sock.setReuseAddress(true);
                    sock.bind(new java.net.InetSocketAddress(DISCOVERY_PORT));
                    sock.setBroadcast(true);
                    sock.setSoTimeout(500); // 每次最多等 500ms，轮询直到 deadline
                    byte[] buf = new byte[512];
                    long deadline = System.currentTimeMillis() + timeout;
                    while (System.currentTimeMillis() < deadline) {
                        try {
                            java.net.DatagramPacket pkt = new java.net.DatagramPacket(buf, buf.length);
                            sock.receive(pkt);
                            String msg = new String(pkt.getData(), 0, pkt.getLength(), "UTF-8");
                            if (msg.contains("RVB_DISCOVER") && !seen.contains(msg)) {
                                seen.add(msg);
                                final String safeMsg = msg;
                                runOnUiThread(() -> getBridge().getWebView()
                                    .evaluateJavascript("window._onUdpHostFound&&window._onUdpHostFound(" + safeMsg + ")", null));
                            }
                        } catch (java.net.SocketTimeoutException ignored) {}
                    }
                    sock.close();
                } catch (Exception e) {
                    android.util.Log.w("RvB", "discoverHosts error: " + e.getMessage());
                } finally {
                    try { lock.release(); } catch (Exception ignored) {}
                }
                runOnUiThread(() -> getBridge().getWebView()
                    .evaluateJavascript("window._onUdpDiscoveryDone&&window._onUdpDiscoveryDone()", null));
            }).start();
        }

        @JavascriptInterface
        public String getMobileServerStatus() {
            boolean running = mobileHttpServer != null && mobileHttpServer.isAlive();
            String ip = running ? getLocalIpAddress() : "";
            return "{\"ok\":" + running + ",\"running\":" + running +
                   ",\"ip\":\"" + ip + "\",\"port\":" + MOBILE_SERVER_PORT + "}";
        }

        @JavascriptInterface
        public String requestMobileServer(String method, String path, String bodyJson, String headersJson) {
            GameEngineWebView engine = gameEngineWebView;
            if (engine == null) return "{\"error\":\"Server not ready\",\"_status\":503}";
            return engine.processRequest(method, path, bodyJson != null ? bodyJson : "{}", headersJson != null ? headersJson : "{}");
        }

        @JavascriptInterface
        public String getLocalIp() {
            return getLocalIpAddress();
        }

        // ─────────────────────────────────────────────────────────────────────

        @JavascriptInterface
        public String readFileAsBase64(String uriString) {
            try {
                Uri uri = Uri.parse(uriString);
                InputStream inputStream = getContentResolver().openInputStream(uri);
                if (inputStream == null) return null;
                ByteArrayOutputStream outputStream = new ByteArrayOutputStream();
                byte[] buffer = new byte[4096];
                int length;
                while ((length = inputStream.read(buffer)) != -1) {
                    outputStream.write(buffer, 0, length);
                }
                inputStream.close();
                byte[] byteArray = outputStream.toByteArray();
                return android.util.Base64.encodeToString(byteArray, android.util.Base64.NO_WRAP);
            } catch (Exception e) {
                return null;
            }
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        handleZipIntent(getIntent());

        WebView webView = getBridge().getWebView();
        WebSettings settings = webView.getSettings();
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        RvBBridge rvbBridge = new RvBBridge();
        webView.addJavascriptInterface(rvbBridge, "RvBBridge");
        new android.os.Handler(android.os.Looper.getMainLooper())
            .postDelayed(() -> rvbBridge.warmUpMobileServerEngine(), 1500);

        webView.setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override
            public android.webkit.WebResourceResponse shouldInterceptRequest(WebView view, android.webkit.WebResourceRequest request) {
                String urlPath = request.getUrl().getPath();

                if (urlPath != null && (urlPath.endsWith(".json") || urlPath.endsWith(".html"))) {
                    return super.shouldInterceptRequest(view, request);
                }
                if (urlPath != null && urlPath.startsWith("/data/")) {
                    String assetPath = "game_assets" + urlPath;
                    try {
                        AssetManager am = getAssets();
                        InputStream stream = am.open(assetPath);
                        String mimeType = getMimeType(urlPath);
                        return new android.webkit.WebResourceResponse(mimeType, "utf-8", stream);
                    } catch (FileNotFoundException e) {
                    } catch (IOException e) {
                    }
                }
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.proceed();
            }
        });

        checkWebViewVersion();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleZipIntent(intent);
    }

    private void handleZipIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action)) {
            Uri data = intent.getData();
            if (data != null) {
                String mimeType = getContentResolver().getType(data);
                if ("application/zip".equals(mimeType) || data.toString().endsWith(".zip")) {
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_IMPORT_URI, data.toString()).apply();
                }
            }
        }
    }

    private String getMimeType(String path) {
        int dot = path.lastIndexOf('.');
        if (dot < 0) return "application/octet-stream";
        String ext = path.substring(dot + 1).toLowerCase();
        switch (ext) {
            case "js": return "application/javascript";
            case "css": return "text/css";
            case "html": return "text/html";
            case "json": return "application/json";
            case "png": return "image/png";
            case "jpg": return "image/jpeg";
            case "jpeg": return "image/jpeg";
            case "svg": return "image/svg+xml";
            case "txt": return "text/plain";
            default: {
                String m = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
                return m != null ? m : "application/octet-stream";
            }
        }
    }

    private void checkWebViewVersion() {
        try {
            android.content.pm.PackageInfo info = WebViewCompat.getCurrentWebViewPackage(this);
            if (info == null) return;
            String verStr = info.versionName;
            int major = 0;
            try { major = Integer.parseInt(verStr.split("\\.")[0]); } catch (Exception ignored) {}
            if (major > 0 && major < 80) {
                new AlertDialog.Builder(this)
                    .setTitle("WebView 版本过低")
                    .setMessage("您的 Android System WebView 版本为 " + verStr + "，可能导致游戏无法正常运行。\n建议在 Google Play 更新「Android System WebView」。")
                    .setPositiveButton("去更新", (d, w) -> {
                        try {
                            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=com.google.android.webview")));
                        } catch (Exception e) {
                            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=com.google.android.webview")));
                        }
                    })
                    .setNegativeButton("忽略", null)
                    .show();
            }
        } catch (Exception ignored) {}
    }
}
