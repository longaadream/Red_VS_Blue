package com.redvsblue.client;

import android.util.Log;

import org.json.JSONObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import fi.iki.elonen.NanoHTTPD;
import fi.iki.elonen.NanoWSD;

/**
 * Lightweight LAN HTTP+WebSocket server for "host" mode.
 * HTTP requests are forwarded to GameEngineWebView for JS processing.
 * WebSocket clients subscribe to a room and receive action-log broadcasts.
 */
public class MobileHttpServer extends NanoWSD {
    private static final String TAG = "MobileHttpServer";

    private final GameEngineWebView engine;
    private final int serverPort;

    /** roomId (lowercase) → connected WS clients */
    private final Map<String, Set<WebSocket>> roomClients = new ConcurrentHashMap<>();

    public MobileHttpServer(int port, GameEngineWebView engine) throws IOException {
        super(port);
        this.serverPort = port;
        this.engine = engine;
        start(NanoHTTPD.SOCKET_READ_TIMEOUT, false);
        Log.i(TAG, "Mobile HTTP+WS server started on port " + port);
    }

    // ── WebSocket upgrade ─────────────────────────────────────────────────────

    @Override
    protected NanoWSD.WebSocket openWebSocket(IHTTPSession handshake) {
        return new RvBWebSocket(handshake);
    }

    /** Called from JS (AndroidServerBridge.broadcastToRoom) after an action is appended. */
    public void broadcastToRoom(String roomId, String message) {
        Set<WebSocket> clients = roomClients.get(roomId.toLowerCase());
        if (clients == null) return;
        for (WebSocket ws : new ArrayList<>(clients)) {
            try { ws.send(message); } catch (Exception ignored) {}
        }
    }

    // ── HTTP serving ──────────────────────────────────────────────────────────

    @Override
    public Response serve(IHTTPSession session) {
        String method = session.getMethod().name();
        String uri    = session.getUri();

        // /api/ws-info: tell client to use the same port for WS
        if ("GET".equals(method) && "/api/ws-info".equals(uri)) {
            Response r = newFixedLengthResponse("{\"wsPort\":" + serverPort + "}");
            r.addHeader("Content-Type", "application/json; charset=utf-8");
            r.addHeader("Access-Control-Allow-Origin", "*");
            return r;
        }

        // CORS preflight
        if ("OPTIONS".equals(method)) {
            Response r = newFixedLengthResponse(Response.Status.OK, "text/plain", "");
            addCorsHeaders(r);
            return r;
        }

        // Read request body
        String body = "{}";
        if (!method.equals("GET") && !method.equals("HEAD")) {
            try {
                Map<String, String> files = new HashMap<>();
                session.parseBody(files);
                body = files.getOrDefault("postData", "{}");
            } catch (Exception e) {
                Log.w(TAG, "Could not parse body for " + method + " " + uri, e);
            }
        }

        // Build headers JSON for the JS router
        Map<String, String> reqHeaders = session.getHeaders();
        JSONObject headersJson = new JSONObject();
        try {
            String auth = reqHeaders.getOrDefault("authorization", "");
            if (!auth.isEmpty()) headersJson.put("authorization", auth);
            String xPlayerId = reqHeaders.getOrDefault("x-player-id", "");
            if (!xPlayerId.isEmpty()) headersJson.put("x-player-id", xPlayerId);
        } catch (Exception ignored) {}

        // Delegate to game engine WebView
        String responseJson = engine.processRequest(method, uri, body, headersJson.toString());

        // Parse status code
        int statusCode = 200;
        try {
            JSONObject obj = new JSONObject(responseJson);
            if (obj.has("_status")) {
                statusCode = obj.getInt("_status");
                obj.remove("_status");
                responseJson = obj.toString();
            }
        } catch (Exception ignored) {}

        Response response = newFixedLengthResponse(
            statusFromCode(statusCode),
            "application/json; charset=utf-8",
            responseJson
        );
        addCorsHeaders(response);
        return response;
    }

    private static void addCorsHeaders(Response r) {
        r.addHeader("Access-Control-Allow-Origin",  "*");
        r.addHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
        r.addHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Player-Id");
        r.addHeader("Access-Control-Allow-Private-Network", "true");
    }

    private static Response.Status statusFromCode(int code) {
        switch (code) {
            case 200: return Response.Status.OK;
            case 201: return Response.Status.CREATED;
            case 204: return Response.Status.NO_CONTENT;
            case 400: return Response.Status.BAD_REQUEST;
            case 401: return Response.Status.UNAUTHORIZED;
            case 403: return Response.Status.FORBIDDEN;
            case 404: return Response.Status.NOT_FOUND;
            case 409: return Response.Status.CONFLICT;
            default:  return code >= 500 ? Response.Status.INTERNAL_ERROR : Response.Status.OK;
        }
    }

    // ── WebSocket handler ─────────────────────────────────────────────────────

    private class RvBWebSocket extends NanoWSD.WebSocket {
        private String roomId;

        RvBWebSocket(IHTTPSession handshake) {
            super(handshake);
        }

        @Override
        protected void onOpen() {}

        @Override
        protected void onClose(NanoWSD.WebSocketFrame.CloseCode code, String reason, boolean initiatedByRemote) {
            removeFromRoom();
        }

        @Override
        protected void onMessage(NanoWSD.WebSocketFrame message) {
            try {
                JSONObject json = new JSONObject(message.getTextPayload());
                String type = json.optString("type");

                if ("subscribe".equals(type)) {
                    removeFromRoom();
                    roomId = json.optString("roomId", "").toLowerCase();
                    roomClients.computeIfAbsent(roomId,
                        k -> Collections.synchronizedSet(new LinkedHashSet<>())).add(this);
                    send("{\"type\":\"subscribed\",\"roomId\":\"" + roomId + "\",\"role\":\"guest\"}");

                } else if ("ping".equals(type)) {
                    send("{\"type\":\"pong\"}");

                } else if ("action".equals(type) || "gameOver".equals(type)) {
                    if (roomId == null) return;
                    // Forward to JS engine via same path as HTTP POST /api/rooms/:id/battle.
                    // JS appends to action log and calls AndroidServerBridge.broadcastToRoom().
                    engine.processRequest("POST", "/api/rooms/" + roomId + "/battle",
                        json.toString(), "{}");
                }
            } catch (Exception e) {
                Log.w(TAG, "WS onMessage error: " + e.getMessage());
            }
        }

        @Override
        protected void onPong(NanoWSD.WebSocketFrame message) {}

        @Override
        protected void onException(IOException e) {
            removeFromRoom();
        }

        private void removeFromRoom() {
            if (roomId != null) {
                Set<WebSocket> clients = roomClients.get(roomId);
                if (clients != null) clients.remove(this);
            }
        }
    }
}
