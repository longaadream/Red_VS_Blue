package com.redvsblue.client;

import android.annotation.SuppressLint;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Manages a hidden WebView that runs the bundled game engine (mobile-server.js).
 * NanoHTTPD calls processRequest() which routes to the WebView JS via evaluateJavascript.
 * Results come back through the AndroidServerBridge @JavascriptInterface.
 */
@SuppressLint("SetJavaScriptEnabled")
public class GameEngineWebView {
    private static final String TAG = "GameEngineWebView";
    private static final int READY_TIMEOUT_SEC  = 60;
    private static final int REQUEST_TIMEOUT_SEC = 10;

    private WebView webView;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Map<String, CompletableFuture<String>> pending = new ConcurrentHashMap<>();
    private final CountDownLatch readyLatch = new CountDownLatch(1);

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

    /** Initialize the WebView on the UI thread. */
    public GameEngineWebView(Context context) {
        mainHandler.post(() -> {
            webView = new WebView(context);
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
                    Log.e(TAG, "WebView load error " + errorCode + ": " + description + " @ " + url);
                }
                @Override
                public void onPageFinished(WebView view, String url) {
                    Log.i(TAG, "WebView page finished: " + url);
                }
            });
            webView.setWebChromeClient(new WebChromeClient() {
                @Override
                public boolean onConsoleMessage(ConsoleMessage msg) {
                    String level = msg.messageLevel().name();
                    Log.d(TAG, "[JS " + level + "] " + msg.message() + " (" + msg.sourceId() + ":" + msg.lineNumber() + ")");
                    return true;
                }
            });

            webView.loadUrl("file:///android_asset/mobile-server.html");
        });
    }

    /** Called by JS: window.AndroidServerBridge.sendResponse(reqId, responseJson) */
    public class AndroidServerBridge {
        @JavascriptInterface
        public void sendResponse(String reqId, String responseJson) {
            CompletableFuture<String> f = pending.remove(reqId);
            if (f != null) f.complete(responseJson);
        }

        @JavascriptInterface
        public void onReady() {
            Log.i(TAG, "Mobile game server is ready");
            readyLatch.countDown();
        }
    }

    /**
     * Route an HTTP request to the JS game engine.
     * Blocks the calling thread until the JS resolves the promise.
     */
    public String processRequest(String method, String path, String bodyJson, String headersJson) {
        if (!isReady()) {
            Log.w(TAG, "processRequest called before ready — waiting...");
            if (!waitForReady(READY_TIMEOUT_SEC)) {
                return "{\"error\":\"Server not ready\",\"_status\":503}";
            }
        }

        String reqId = UUID.randomUUID().toString().replace("-", "");
        CompletableFuture<String> future = new CompletableFuture<>();
        pending.put(reqId, future);

        String safeBody    = escapeJs(bodyJson    != null ? bodyJson    : "{}");
        String safeHeaders = escapeJs(headersJson != null ? headersJson : "{}");
        String safeMethod  = escapeJs(method);
        String safePath    = escapeJs(path);

        mainHandler.post(() -> {
            if (webView == null) {
                future.completeExceptionally(new RuntimeException("WebView destroyed"));
                return;
            }
            String js = "window.RvBMobileServer && window.RvBMobileServer.processRequest(" +
                "'" + reqId      + "'," +
                "'" + safeMethod + "'," +
                "'" + safePath   + "'," +
                "'" + safeBody   + "'," +
                "'" + safeHeaders + "'" +
                ")";
            webView.evaluateJavascript(js, null);
        });

        try {
            return future.get(REQUEST_TIMEOUT_SEC, TimeUnit.SECONDS);
        } catch (Exception e) {
            pending.remove(reqId);
            Log.e(TAG, "Request timed out: " + method + " " + path, e);
            return "{\"error\":\"Request timeout\",\"_status\":504}";
        }
    }

    public void destroy() {
        mainHandler.post(() -> {
            if (webView != null) {
                webView.stopLoading();
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
