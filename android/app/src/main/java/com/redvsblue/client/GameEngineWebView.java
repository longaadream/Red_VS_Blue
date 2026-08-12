package com.redvsblue.client;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import org.json.JSONObject;

/**
 * Manages a hidden WebView that runs the bundled game engine (mobile-server.js).
 * NanoHTTPD calls processRequest() which routes to the WebView JS via evaluateJavascript.
 * Results come back through the AndroidServerBridge @JavascriptInterface.
 */
@SuppressLint("SetJavaScriptEnabled")
public class GameEngineWebView {
    private static final String TAG = "GameEngineWebView";
    private static final int READY_TIMEOUT_SEC  = 60;
    private static final int REQUEST_TIMEOUT_SEC = 30;

    private WebView webView;
    private ViewGroup attachedParent;
    private volatile String lastEvent = "created";
    private volatile String lastError = "";
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Map<String, CompletableFuture<String>> pending = new ConcurrentHashMap<>();
    private final Map<String, String[]> pendingRequestChunks = new ConcurrentHashMap<>();
    private final Map<String, StringBuilder> pendingResponseChunks = new ConcurrentHashMap<>();
    private final CountDownLatch readyLatch = new CountDownLatch(1);
    private volatile MobileHttpServer wsServer;
    private static final int BRIDGE_CHUNK_SIZE = 48 * 1024;

    public void setWsServer(MobileHttpServer server) {
        this.wsServer = server;
    }

    // Called from NanoHTTPD thread — waits for the WebView to become ready.
    public boolean waitForReady(int timeoutSec) {
        try {
            return readyLatch.await(timeoutSec, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    public boolean isReady() {
        return readyLatch.getCount() == 0;
    }

    public String getDebugStatusJson() {
        return "{"
            + "\"ready\":" + isReady() + ","
            + "\"hasWebView\":" + (webView != null) + ","
            + "\"attached\":" + (attachedParent != null) + ","
            + "\"pending\":" + pending.size() + ","
            + "\"lastEvent\":" + JSONObject.quote(lastEvent) + ","
            + "\"lastError\":" + JSONObject.quote(lastError)
            + "}";
    }

    /** Initialize the WebView on the UI thread. */
    public GameEngineWebView(Context context) {
        mainHandler.post(() -> {
            lastEvent = "creating-webview";
            webView = new WebView(context);
            if (context instanceof Activity) {
                FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(1, 1);
                params.gravity = Gravity.BOTTOM | Gravity.RIGHT;
                webView.setAlpha(0.01f);
                ((Activity) context).addContentView(webView, params);
                if (webView.getParent() instanceof ViewGroup) {
                    attachedParent = (ViewGroup) webView.getParent();
                }
            }
            WebSettings settings = webView.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setAllowFileAccess(true);
            @SuppressWarnings("deprecation")
            Runnable suppressUniversalAccess = () -> settings.setAllowUniversalAccessFromFileURLs(true);
            suppressUniversalAccess.run();

            webView.addJavascriptInterface(new AndroidServerBridge(), "AndroidServerBridge");

            webView.setWebViewClient(new android.webkit.WebViewClient() {
                @Override
                public void onReceivedError(WebView view, int errorCode, String description, String url) {
                    lastEvent = "load-error";
                    lastError = errorCode + ": " + description + " @ " + url;
                    Log.e(TAG, "WebView load error " + lastError);
                }
                @Override
                public void onPageFinished(WebView view, String url) {
                    lastEvent = "page-finished";
                    Log.i(TAG, "WebView page finished: " + url);
                    view.evaluateJavascript(
                        "window.RvBMobileServer&&window.AndroidServerBridge&&window.AndroidServerBridge.onReady&&window.AndroidServerBridge.onReady()",
                        null
                    );
                }
            });
            webView.setWebChromeClient(new WebChromeClient() {
                @Override
                public boolean onConsoleMessage(ConsoleMessage msg) {
                    String level = msg.messageLevel().name();
                    if ("ERROR".equals(level)) {
                        lastEvent = "console-error";
                        lastError = msg.message() + " (" + msg.sourceId() + ":" + msg.lineNumber() + ")";
                        Log.e(TAG, "[JS " + level + "] " + msg.message() + " (" + msg.sourceId() + ":" + msg.lineNumber() + ")");
                    } else if ("WARNING".equals(level)) {
                        Log.w(TAG, "[JS " + level + "] " + msg.message() + " (" + msg.sourceId() + ":" + msg.lineNumber() + ")");
                    }
                    return true;
                }
            });

            lastEvent = "loading-page";
            webView.loadUrl("file:///android_asset/mobile-server.html");
        });
    }

    /** Called by JS: window.AndroidServerBridge.sendResponse(reqId, responseJson) */
    public class AndroidServerBridge {
        @JavascriptInterface
        public void sendResponse(String reqId, String responseJson) {
            lastEvent = "response";
            CompletableFuture<String> f = pending.remove(reqId);
            pendingRequestChunks.remove(reqId);
            if (f != null) f.complete(responseJson);
        }

        @JavascriptInterface
        public void sendResponseChunk(String reqId, String chunk) {
            StringBuilder sb = pendingResponseChunks.computeIfAbsent(reqId, k -> new StringBuilder());
            sb.append(chunk != null ? chunk : "");
        }

        @JavascriptInterface
        public void sendResponseComplete(String reqId) {
            lastEvent = "response-complete";
            StringBuilder sb = pendingResponseChunks.remove(reqId);
            CompletableFuture<String> f = pending.remove(reqId);
            pendingRequestChunks.remove(reqId);
            if (f != null) f.complete(sb != null ? sb.toString() : "");
        }

        @JavascriptInterface
        public int getRequestChunkCount(String reqId) {
            String[] chunks = pendingRequestChunks.get(reqId);
            return chunks != null ? chunks.length : 0;
        }

        @JavascriptInterface
        public String getRequestChunk(String reqId, int index) {
            String[] chunks = pendingRequestChunks.get(reqId);
            if (chunks == null || index < 0 || index >= chunks.length) return "";
            return chunks[index];
        }

        @JavascriptInterface
        public void onReady() {
            lastEvent = "ready";
            Log.i(TAG, "Mobile game server is ready");
            readyLatch.countDown();
        }

        /** Called by JS after appending an action log entry — broadcasts to WS room clients. */
        @JavascriptInterface
        public void broadcastToRoom(String roomId, String message) {
            MobileHttpServer srv = wsServer;
            if (srv != null) srv.broadcastToRoom(roomId, message);
        }
    }

    /**
     * Route an HTTP request to the JS game engine.
     * Blocks the calling thread until the JS resolves the promise.
     */
    public String processRequest(String method, String path, String bodyJson, String headersJson) {
        if (!isReady()) {
            lastEvent = "request-wait-ready";
            Log.w(TAG, "processRequest called before ready — waiting...");
            if (!waitForReady(READY_TIMEOUT_SEC)) {
                lastEvent = "request-not-ready";
                lastError = "waitForReady timeout";
                return "{\"error\":\"Server not ready\",\"_status\":503}";
            }
        }

        String reqId = UUID.randomUUID().toString().replace("-", "");
        CompletableFuture<String> future = new CompletableFuture<>();
        pending.put(reqId, future);

        String payload = "{"
            + "\"method\":" + JSONObject.quote(method != null ? method : "GET") + ","
            + "\"path\":" + JSONObject.quote(path != null ? path : "/") + ","
            + "\"bodyJson\":" + JSONObject.quote(bodyJson != null ? bodyJson : "{}") + ","
            + "\"headersJson\":" + JSONObject.quote(headersJson != null ? headersJson : "{}")
            + "}";
        mainHandler.post(() -> {
            if (webView == null) {
                lastEvent = "request-no-webview";
                lastError = "WebView destroyed";
                future.completeExceptionally(new RuntimeException("WebView destroyed"));
                return;
            }
            lastEvent = "request-dispatched:" + method + " " + path;
            if (payload.length() <= 24000) {
                String js = "window.RvBMobileServer && window.RvBMobileServer.processRequest("
                    + "'" + escapeJs(reqId) + "',"
                    + JSONObject.quote(method != null ? method : "GET") + ","
                    + JSONObject.quote(path != null ? path : "/") + ","
                    + JSONObject.quote(bodyJson != null ? bodyJson : "{}") + ","
                    + JSONObject.quote(headersJson != null ? headersJson : "{}")
                    + ")";
                webView.evaluateJavascript(js, null);
            } else {
                String[] chunks = splitChunks(payload);
                webView.evaluateJavascript("window.RvBMobileServer&&window.RvBMobileServer.beginBridgeRequest('"
                    + escapeJs(reqId) + "')", null);
                for (String chunk : chunks) {
                    webView.evaluateJavascript("window.RvBMobileServer&&window.RvBMobileServer.appendBridgeRequestChunk('"
                        + escapeJs(reqId) + "'," + JSONObject.quote(chunk) + ")", null);
                }
                webView.evaluateJavascript("window.RvBMobileServer&&window.RvBMobileServer.finishBridgeRequest('"
                    + escapeJs(reqId) + "')", null);
            }
        });

        try {
            return future.get(REQUEST_TIMEOUT_SEC, TimeUnit.SECONDS);
        } catch (Exception e) {
            pending.remove(reqId);
            pendingRequestChunks.remove(reqId);
            pendingResponseChunks.remove(reqId);
            lastEvent = "request-timeout";
            lastError = method + " " + path + ": " + (e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName());
            Log.e(TAG, "Request timed out: " + method + " " + path, e);
            return "{\"error\":\"Request timeout\",\"_status\":504}";
        }
    }

    private static String[] splitChunks(String value) {
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

    public void destroy() {
        mainHandler.post(() -> {
            if (webView != null) {
                webView.stopLoading();
                if (attachedParent != null) {
                    attachedParent.removeView(webView);
                    attachedParent = null;
                }
                webView.destroy();
                webView = null;
            }
        });
    }

    // Escape a string for safe embedding inside a JS single-quoted string literal.
    private static String escapeJs(String s) {
        return s.replace("\\", "\\\\")
                .replace("'",  "\\'")
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("\t", "\\t");
    }
}
