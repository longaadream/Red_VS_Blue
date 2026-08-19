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
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.FileNotFoundException;
import java.nio.charset.StandardCharsets;
import java.net.Inet4Address;
import java.net.NetworkInterface;
import java.util.Collections;
import java.util.Enumeration;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ConcurrentHashMap;

import org.json.JSONArray;
import org.json.JSONObject;

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
    private volatile boolean  pendingOpenPackPage = false;
    private final Map<String, PendingMobileRequest> pendingMobileRequests = new ConcurrentHashMap<>();
    private final Map<String, String[]> pendingMobileResponses = new ConcurrentHashMap<>();
    private static final int BRIDGE_CHUNK_SIZE = 48 * 1024;
    private static final int HTTP_START_TIMEOUT_MS = 5000;
    private volatile String mobileServerStage = "idle";
    private volatile String mobileServerLastError = "";
    private volatile String mobileServerSelfTest = "not-run";

    // ── UDP host broadcast ────────────────────────────────────────────────────
    private Thread            broadcastThread   = null;
    private volatile boolean  broadcastRunning  = false;

    private File getPackRoot() {
        return new File(getFilesDir(), "resource-pack");
    }

    private File resolvePackFile(String rawPath) throws IOException {
        String rel = rawPath != null ? rawPath : "";
        int queryIdx = rel.indexOf('?');
        if (queryIdx >= 0) rel = rel.substring(0, queryIdx);
        rel = rel.replace('\\', '/');
        while (rel.startsWith("/")) rel = rel.substring(1);
        if (rel.length() == 0) rel = "index.html";
        File root = getPackRoot().getCanonicalFile();
        File out = new File(root, rel).getCanonicalFile();
        if (!out.getPath().startsWith(root.getPath() + File.separator) && !out.equals(root)) {
            throw new IOException("Unsafe resource pack path");
        }
        return out;
    }

    private boolean shouldBypassPackOverride(String rawPath) {
        String rel = rawPath != null ? rawPath : "";
        int queryIdx = rel.indexOf('?');
        if (queryIdx >= 0) rel = rel.substring(0, queryIdx);
        rel = rel.replace('\\', '/').toLowerCase();
        while (rel.startsWith("/")) rel = rel.substring(1);
        return rel.equals("pack.html")
            || rel.equals("data/pages/pack.html")
            || rel.equals("js/pack-fetch.js");
    }

    private boolean shouldSkipProtectedPackFile(String rawPath) {
        return shouldBypassPackOverride(rawPath);
    }

    private boolean isUiHtmlPath(String rawPath) {
        String rel = rawPath != null ? rawPath : "";
        int queryIdx = rel.indexOf('?');
        if (queryIdx >= 0) rel = rel.substring(0, queryIdx);
        rel = rel.replace('\\', '/').toLowerCase();
        while (rel.startsWith("/")) rel = rel.substring(1);
        return rel.equals("battle.html")
            || rel.equals("training.html")
            || rel.equals("data/pages/battle.html")
            || rel.equals("data/pages/training.html");
    }

    private boolean packUiFileIsCurrent(File file) {
        if (file == null || !file.exists() || !file.isFile()) return false;
        try (InputStream in = new java.io.FileInputStream(file)) {
            byte[] buf = new byte[(int)Math.min(file.length(), 256 * 1024)];
            int n = in.read(buf);
            if (n <= 0) return false;
            String text = new String(buf, 0, n, StandardCharsets.UTF_8);
            return text.contains("UI 20260517");
        } catch (Exception ignored) {
            return false;
        }
    }

    private void deleteRecursive(File file) {
        if (file == null || !file.exists()) return;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) deleteRecursive(child);
            }
        }
        file.delete();
    }

    private void openPackPage(WebView webView) {
        if (webView == null) return;
        String current = webView.getUrl();
        String target = "https://localhost/pack.html";
        try {
            if (current != null && (current.startsWith("http://") || current.startsWith("https://"))) {
                Uri uri = Uri.parse(current);
                String scheme = uri.getScheme() != null ? uri.getScheme() : "https";
                String authority = uri.getAuthority() != null ? uri.getAuthority() : "localhost";
                target = scheme + "://" + authority + "/pack.html";
            }
        } catch (Exception ignored) {}
        webView.loadUrl(target);
    }

    private void listPackFiles(File root, File dir, JSONArray files) {
        File[] children = dir.listFiles();
        if (children == null) return;
        for (File child : children) {
            if (child.isDirectory()) {
                listPackFiles(root, child, files);
            } else {
                String rel = root.toURI().relativize(child.toURI()).getPath();
                files.put("/" + rel.replace('\\', '/'));
            }
        }
    }

    private static class PendingMobileRequest {
        final String method;
        final String path;
        final String headersJson;
        final StringBuilder body = new StringBuilder();
        PendingMobileRequest(String method, String path, String headersJson) {
            this.method = method;
            this.path = path;
            this.headersJson = headersJson;
        }
    }

    private static class ServerStartResult {
        MobileHttpServer server;
        Exception error;
        boolean done;
    }

    private static String[] splitBridgeChunks(String value) {
        String s = value != null ? value : "";
        int count = Math.max(1, (s.length() + BRIDGE_CHUNK_SIZE - 1) / BRIDGE_CHUNK_SIZE);
        String[] chunks = new String[count];
        for (int i = 0; i < count; i++) {
            int start = i * BRIDGE_CHUNK_SIZE;
            int end = Math.min(s.length(), start + BRIDGE_CHUNK_SIZE);
            chunks[i] = s.substring(start, end);
        }
        return chunks;
    }

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

        @JavascriptInterface
        public String packWriteFiles(String filesJson) {
            try {
                JSONArray files = new JSONArray(filesJson != null ? filesJson : "[]");
                File root = getPackRoot();
                if (!root.exists()) root.mkdirs();
                int count = 0;
                for (int i = 0; i < files.length(); i++) {
                    JSONObject file = files.getJSONObject(i);
                    String path = file.optString("path", "");
                    if (path.equals("/pack.json") || path.equals("pack.json")) continue;
                    if (shouldSkipProtectedPackFile(path)) continue;
                    byte[] data = android.util.Base64.decode(file.optString("content", ""), android.util.Base64.DEFAULT);
                    File out = resolvePackFile(path);
                    File parent = out.getParentFile();
                    if (parent != null && !parent.exists()) parent.mkdirs();
                    try (FileOutputStream fos = new FileOutputStream(out)) {
                        fos.write(data);
                    }
                    count++;
                }
                return "{\"ok\":true,\"count\":" + count + "}";
            } catch (Exception e) {
                String msg = e.getMessage() != null ? e.getMessage().replace("\"", "'") : "unknown";
                return "{\"ok\":false,\"error\":\"" + msg + "\"}";
            }
        }

        @JavascriptInterface
        public String packClear() {
            try {
                deleteRecursive(getPackRoot());
                return "{\"ok\":true}";
            } catch (Exception e) {
                String msg = e.getMessage() != null ? e.getMessage().replace("\"", "'") : "unknown";
                return "{\"ok\":false,\"error\":\"" + msg + "\"}";
            }
        }

        @JavascriptInterface
        public String packList() {
            try {
                JSONArray files = new JSONArray();
                File root = getPackRoot();
                if (root.exists()) listPackFiles(root.getCanonicalFile(), root.getCanonicalFile(), files);
                JSONObject out = new JSONObject();
                out.put("ok", true);
                out.put("files", files);
                return out.toString();
            } catch (Exception e) {
                String msg = e.getMessage() != null ? e.getMessage().replace("\"", "'") : "unknown";
                return "{\"ok\":false,\"files\":[],\"error\":\"" + msg + "\"}";
            }
        }

        // ── LAN host server ───────────────────────────────────────────────────

        @JavascriptInterface
        public String startMobileEngine() {
            if (gameEngineWebView != null && gameEngineWebView.isReady()) {
                return "{\"ok\":true,\"ready\":true}";
            }
            if (engineWarming || serverStarting) return "{\"ok\":false,\"starting\":true,\"ready\":false}";
            engineWarming = true;
            mobileServerStage = "engine-start-called";
            mobileServerLastError = "";
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
                    if (!uiLatch.await(5, java.util.concurrent.TimeUnit.SECONDS)) {
                        mobileServerStage = "engine-ui-init-timeout";
                        mobileServerLastError = "UI init timeout";
                        engineWarming = false;
                        fireServerReady("{\"ok\":false,\"ready\":false,\"error\":\"UI init timeout\"}");
                        return;
                    }
                    mobileServerStage = "engine-waiting-ready";
                    if (holder[0] == null || !holder[0].waitForReady(60)) {
                        mobileServerStage = "engine-ready-timeout";
                        mobileServerLastError = "engine init timeout";
                        engineWarming = false;
                        fireServerReady("{\"ok\":false,\"ready\":false,\"error\":\"engine init timeout\"}");
                        return;
                    }
                    mobileServerStage = "engine-ready";
                    engineWarming = false;
                    fireServerReady("{\"ok\":true,\"ready\":true}");
                } catch (Exception e) {
                    engineWarming = false;
                    mobileServerStage = "engine-failed";
                    String msg = e.getMessage() != null ? e.getMessage().replace("\"","'") : "unknown";
                    mobileServerLastError = msg;
                    fireServerReady("{\"ok\":false,\"ready\":false,\"error\":\"" + msg + "\"}");
                }
            }).start();
            return "{\"ok\":false,\"starting\":true,\"ready\":false}";
        }

        @JavascriptInterface
        public String startMobileServer() {
            mobileServerStage = "start-called";
            mobileServerLastError = "";
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
                    mobileServerStage = "creating-engine";
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
                            mobileServerStage = "ui-init-timeout";
                            mobileServerLastError = "UI init timeout";
                            serverStarting = false;
                            fireServerReady("{\"ok\":false,\"error\":\"UI init timeout\",\"running\":false}");
                            return;
                        }
                        engine = holder[0];
                    }
                    mobileServerStage = "waiting-engine-ready";
                    if (!engine.waitForReady(60)) {
                        final GameEngineWebView failedEngine = engine;
                        runOnUiThread(() -> failedEngine.destroy());
                        if (gameEngineWebView == engine) gameEngineWebView = null;
                        mobileServerStage = "engine-ready-timeout";
                        mobileServerLastError = "engine init timeout";
                        serverStarting = false;
                        fireServerReady("{\"ok\":false,\"error\":\"游戏引擎初始化超时（60秒）\",\"running\":false}");
                        return;
                    }
                    mobileServerStage = "starting-http";
                    final GameEngineWebView readyEngine = engine;
                    final ServerStartResult startResult = new ServerStartResult();
                    Thread serverThread = new Thread(() -> {
                        try {
                            startResult.server = new MobileHttpServer(MOBILE_SERVER_PORT, readyEngine);
                        } catch (Exception e) {
                            startResult.error = e;
                        } finally {
                            synchronized (startResult) {
                                startResult.done = true;
                                startResult.notifyAll();
                            }
                        }
                    }, "RvB-MobileHttpServer-Start");
                    serverThread.setDaemon(true);
                    serverThread.start();
                    synchronized (startResult) {
                        if (!startResult.done) startResult.wait(HTTP_START_TIMEOUT_MS);
                    }
                    if (!startResult.done) {
                        serverStarting = false;
                        mobileServerStage = "http-start-timeout";
                        mobileServerLastError = "HTTP server start timed out after " + HTTP_START_TIMEOUT_MS + "ms";
                        fireServerReady("{\"ok\":false,\"error\":\"HTTP start timeout\",\"running\":false}");
                        return;
                    }
                    if (startResult.error != null) {
                        serverStarting = false;
                        mobileServerStage = "http-start-failed";
                        mobileServerLastError = startResult.error.getMessage() != null ? startResult.error.getMessage() : startResult.error.getClass().getSimpleName();
                        fireServerReady("{\"ok\":false,\"error\":\"" + mobileServerLastError.replace("\"","'") + "\",\"running\":false}");
                        return;
                    }
                    MobileHttpServer server = startResult.server;
                    engine.setWsServer(server);
                    mobileServerStage = "self-test";
                    String selfTestResponse = engine.processRequest("GET", "/api/maps", "{}", "{}");
                    mobileServerSelfTest = selfTestResponse != null && selfTestResponse.contains("\"error\"")
                        ? selfTestResponse
                        : "ok";
                    if (!"ok".equals(mobileServerSelfTest)) {
                        server.stop();
                        serverStarting = false;
                        mobileServerStage = "self-test-failed";
                        mobileServerLastError = mobileServerSelfTest;
                        fireServerReady("{\"ok\":false,\"error\":\"self-test failed\",\"running\":false}");
                        return;
                    }
                    gameEngineWebView = engine;
                    mobileHttpServer  = server;
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                        .putString(KEY_URL, "http://localhost:" + MOBILE_SERVER_PORT)
                        .apply();
                    serverStarting = false;
                    mobileServerStage = "running";
                    fireServerReady(getMobileServerStatus());
                } catch (Exception e) {
                    serverStarting = false;
                    mobileServerStage = "failed";
                    String msg = e.getMessage() != null ? e.getMessage().replace("\"","'") : "unknown";
                    mobileServerLastError = msg;
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
        public String getMobileServerDebugStatus() {
            boolean running = mobileHttpServer != null && mobileHttpServer.isAlive();
            GameEngineWebView engine = gameEngineWebView;
            String engineJson = engine != null ? engine.getDebugStatusJson() : "null";
            return "{"
                + "\"running\":" + running + ","
                + "\"starting\":" + serverStarting + ","
                + "\"warming\":" + engineWarming + ","
                + "\"stage\":" + JSONObject.quote(mobileServerStage) + ","
                + "\"lastError\":" + JSONObject.quote(mobileServerLastError) + ","
                + "\"selfTest\":" + JSONObject.quote(mobileServerSelfTest) + ","
                + "\"engine\":" + engineJson
                + "}";
        }

        @JavascriptInterface
        public String requestMobileServer(String method, String path, String bodyJson, String headersJson) {
            GameEngineWebView engine = gameEngineWebView;
            if (engine == null) return "{\"error\":\"Server not ready\",\"_status\":503}";
            return engine.processRequest(method, path, bodyJson != null ? bodyJson : "{}", headersJson != null ? headersJson : "{}");
        }

        @JavascriptInterface
        public String requestMobileEngine(String method, String path, String bodyJson, String headersJson) {
            GameEngineWebView engine = gameEngineWebView;
            if (engine == null) return "{\"error\":\"Engine not ready\",\"_status\":503}";
            return engine.processRequest(method, path, bodyJson != null ? bodyJson : "{}", headersJson != null ? headersJson : "{}");
        }

        @JavascriptInterface
        public void requestMobileServerAsync(String method, String path, String bodyJson, String headersJson, String callbackId) {
            new Thread(() -> {
                String responseJson;
                try {
                    GameEngineWebView engine = gameEngineWebView;
                    if (engine == null) {
                        responseJson = "{\"error\":\"Engine not ready\",\"_status\":503}";
                    } else {
                        responseJson = engine.processRequest(
                            method != null ? method : "GET",
                            path != null ? path : "/",
                            bodyJson != null ? bodyJson : "{}",
                            headersJson != null ? headersJson : "{}"
                        );
                    }
                } catch (Exception e) {
                    String msg = e.getMessage() != null ? e.getMessage().replace("\"","'") : "unknown";
                    responseJson = "{\"error\":\"" + msg + "\",\"_status\":500}";
                }
                final String safeCallbackId = callbackId != null ? callbackId.replace("\\", "\\\\").replace("'", "\\'") : "";
                final String safeResponse = JSONObject.quote(responseJson != null ? responseJson : "{}");
                runOnUiThread(() -> getBridge().getWebView().evaluateJavascript(
                    "window._rvbMobileServerCallbacks&&window._rvbMobileServerCallbacks['" + safeCallbackId + "']&&window._rvbMobileServerCallbacks['" + safeCallbackId + "'](" + safeResponse + ")",
                    null
                ));
            }, "RvB-MobileServer-AsyncRequest").start();
        }

        @JavascriptInterface
        public String beginMobileServerRequest(String method, String path, String headersJson) {
            String reqId = UUID.randomUUID().toString().replace("-", "");
            pendingMobileRequests.put(reqId, new PendingMobileRequest(
                method != null ? method : "GET",
                path != null ? path : "/",
                headersJson != null ? headersJson : "{}"
            ));
            return reqId;
        }

        @JavascriptInterface
        public void appendMobileServerRequestChunk(String reqId, String chunk) {
            PendingMobileRequest req = pendingMobileRequests.get(reqId);
            if (req != null && chunk != null) req.body.append(chunk);
        }

        @JavascriptInterface
        public String finishMobileServerRequest(String reqId) {
            PendingMobileRequest req = pendingMobileRequests.remove(reqId);
            if (req == null) return "{\"error\":\"Request not found\",\"_status\":400}";
            GameEngineWebView engine = gameEngineWebView;
            if (engine == null) return "{\"error\":\"Server not ready\",\"_status\":503}";
            String responseJson = engine.processRequest(req.method, req.path, req.body.length() > 0 ? req.body.toString() : "{}", req.headersJson);
            if (responseJson != null && responseJson.length() > 32000) {
                String responseId = UUID.randomUUID().toString().replace("-", "");
                pendingMobileResponses.put(responseId, splitBridgeChunks(responseJson));
                return "{\"_bridgeChunked\":true,\"responseId\":\"" + responseId + "\"}";
            }
            return responseJson;
        }

        @JavascriptInterface
        public int getMobileServerResponseChunkCount(String responseId) {
            String[] chunks = pendingMobileResponses.get(responseId);
            return chunks != null ? chunks.length : 0;
        }

        @JavascriptInterface
        public String getMobileServerResponseChunk(String responseId, int index) {
            String[] chunks = pendingMobileResponses.get(responseId);
            if (chunks == null || index < 0 || index >= chunks.length) return "";
            return chunks[index];
        }

        @JavascriptInterface
        public void clearMobileServerResponse(String responseId) {
            pendingMobileResponses.remove(responseId);
        }

        @JavascriptInterface
        public String getLocalIp() {
            return getLocalIpAddress();
        }

        // ─────────────────────────────────────────────────────────────────────

        @JavascriptInterface
        public String readFileAsBase64(String uriString) {
            try {
                InputStream inputStream;
                // Absolute path saved by handleZipIntent (cache dir) — no ContentResolver needed
                if (uriString != null && uriString.startsWith("/")) {
                    inputStream = new java.io.FileInputStream(uriString);
                } else {
                    Uri uri = Uri.parse(uriString);
                    inputStream = getContentResolver().openInputStream(uri);
                }
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
        // Fullscreen: hide status bar across all Android versions
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            getWindow().getInsetsController().hide(android.view.WindowInsets.Type.statusBars());
            getWindow().getInsetsController().setSystemBarsBehavior(
                android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        } else {
            getWindow().setFlags(
                android.view.WindowManager.LayoutParams.FLAG_FULLSCREEN,
                android.view.WindowManager.LayoutParams.FLAG_FULLSCREEN
            );
        }
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

                // 1. Pack override: non-bypassed paths check resource-pack/ first
                if (urlPath != null && !shouldBypassPackOverride(urlPath)) {
                    try {
                        File packFile = resolvePackFile(urlPath);
                        if (packFile.exists() && packFile.isFile()) {
                            boolean packIsCurrent = !isUiHtmlPath(urlPath) || packUiFileIsCurrent(packFile);
                            if (packIsCurrent) {
                                return new android.webkit.WebResourceResponse(
                                    getMimeType(urlPath),
                                    "utf-8",
                                    new java.io.FileInputStream(packFile)
                                );
                            }
                            // outdated UI file — fall through to APK asset below
                        }
                    } catch (Exception ignored) {
                    }
                }

                // 2. Serve any file directly from APK public/ assets.
                //    This bypasses Capacitor's WebViewAssetLoader which can return null on
                //    some Android versions, causing a white/blank screen on normal startup.
                if (urlPath != null) {
                    String rel = urlPath.startsWith("/") ? urlPath.substring(1) : urlPath;
                    // Strip query string
                    int qi = rel.indexOf('?');
                    if (qi >= 0) rel = rel.substring(0, qi);
                    if (rel.isEmpty()) rel = "index.html";
                    try {
                        InputStream stream = getAssets().open("public/" + rel);
                        return new android.webkit.WebResourceResponse(getMimeType(rel), "utf-8", stream);
                    } catch (IOException ignored) {
                        // File not in APK public/ — fall through to Capacitor
                    }
                }

                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (pendingOpenPackPage) {
                    pendingOpenPackPage = false;
                    openPackPage(view);
                }
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
        if (!Intent.ACTION_VIEW.equals(action)) return;
        Uri data = intent.getData();
        if (data == null) return;
        String mimeType = getContentResolver().getType(data);
        String uriStr = data.toString();
        String uriLower = uriStr != null ? uriStr.toLowerCase() : "";
        boolean isZip = "application/zip".equals(mimeType)
            || "application/x-zip-compressed".equals(mimeType)
            || "application/octet-stream".equals(mimeType)
            || uriLower.endsWith(".zip")
            || uriLower.contains(".zip?");
        if (!isZip) return;

        // Copy ZIP to cache immediately while content:// URI permission is still valid.
        // Saving the URI string and reading it later from JS often fails because the
        // temporary ContentResolver grant expires after the intent is handled.
        new Thread(() -> {
            try {
                File tmpZip = new File(getCacheDir(), "pending-pack.zip");
                try (InputStream in = getContentResolver().openInputStream(data);
                     FileOutputStream fos = new FileOutputStream(tmpZip)) {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) != -1) fos.write(buf, 0, n);
                }
                // Store absolute path so readFileAsBase64 can read it without permissions
                getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                    .putString(KEY_IMPORT_URI, tmpZip.getAbsolutePath())
                    .apply();
                pendingOpenPackPage = true;
                runOnUiThread(() -> {
                    WebView wv = getBridge().getWebView();
                    if (wv != null && wv.getUrl() != null) {
                        pendingOpenPackPage = false;
                        openPackPage(wv);
                    }
                });
            } catch (Exception e) {
                android.util.Log.e("RvB", "handleZipIntent copy failed: " + e.getMessage());
            }
        }).start();
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
