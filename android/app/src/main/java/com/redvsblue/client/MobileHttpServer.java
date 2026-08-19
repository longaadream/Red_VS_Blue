package com.redvsblue.client;

import android.util.Base64;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Small Android LAN HTTP+WebSocket server for host mode.
 * Avoids NanoHTTPD startup hangs seen on some WebView/Android combinations.
 */
public class MobileHttpServer {
    private static final String TAG = "MobileHttpServer";
    private static final String WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    private final GameEngineWebView engine;
    private final int serverPort;
    private final ServerSocket serverSocket;
    private final AtomicBoolean running = new AtomicBoolean(true);
    private final Thread acceptThread;
    private final Map<String, Set<WsClient>> roomClients = new ConcurrentHashMap<>();

    public MobileHttpServer(int port, GameEngineWebView engine) throws IOException {
        this.serverPort = port;
        this.engine = engine;
        this.serverSocket = new ServerSocket();
        this.serverSocket.setReuseAddress(true);
        this.serverSocket.bind(new InetSocketAddress("0.0.0.0", port));
        this.acceptThread = new Thread(this::acceptLoop, "RvB-MobileHttpServer");
        this.acceptThread.setDaemon(true);
        this.acceptThread.start();
        Log.i(TAG, "Mobile HTTP+WS server started on 0.0.0.0:" + port);
    }

    public boolean isAlive() {
        return running.get() && !serverSocket.isClosed() && acceptThread.isAlive();
    }

    public void stop() {
        running.set(false);
        try { serverSocket.close(); } catch (Exception ignored) {}
        try { acceptThread.interrupt(); } catch (Exception ignored) {}
        for (Set<WsClient> clients : roomClients.values()) {
            for (WsClient client : new ArrayList<>(clients)) client.close();
        }
        roomClients.clear();
    }

    public void broadcastToRoom(String roomId, String message) {
        if (roomId == null) return;
        Set<WsClient> clients = roomClients.get(roomId.toLowerCase(Locale.ROOT));
        if (clients == null) return;
        for (WsClient client : new ArrayList<>(clients)) client.sendText(message);
    }

    private void acceptLoop() {
        while (running.get()) {
            try {
                Socket socket = serverSocket.accept();
                Thread t = new Thread(() -> handleSocket(socket), "RvB-MobileHttpClient");
                t.setDaemon(true);
                t.start();
            } catch (IOException e) {
                if (running.get()) Log.w(TAG, "accept failed: " + e.getMessage());
            }
        }
    }

    private void handleSocket(Socket socket) {
        try (Socket s = socket) {
            s.setSoTimeout(30000);
            BufferedInputStream in = new BufferedInputStream(s.getInputStream());
            OutputStream out = s.getOutputStream();
            Request req = readRequest(in);
            if (req == null) return;
            if (isWebSocketRequest(req)) {
                handleWebSocket(s, in, out, req);
                return;
            }
            handleHttp(out, req);
        } catch (Exception e) {
            Log.w(TAG, "client handling failed: " + e.getMessage());
        }
    }

    private void handleHttp(OutputStream out, Request req) throws IOException {
        if ("GET".equals(req.method) && "/api/ws-info".equals(req.path)) {
            writeJson(out, 200, "{\"transport\":\"same-origin\",\"path\":\"/ws/rooms/{roomId}\"}");
            return;
        }
        if ("OPTIONS".equals(req.method)) {
            writeResponse(out, 200, "text/plain; charset=utf-8", "");
            return;
        }

        JSONObject headersJson = new JSONObject();
        try {
            String auth = req.headers.getOrDefault("authorization", "");
            if (!auth.isEmpty()) headersJson.put("authorization", auth);
            String xPlayerId = req.headers.getOrDefault("x-player-id", "");
            if (!xPlayerId.isEmpty()) headersJson.put("x-player-id", xPlayerId);
        } catch (Exception ignored) {}

        String responseJson = engine.processRequest(req.method, req.pathWithQuery, req.body, headersJson.toString());
        int statusCode = 200;
        try {
            JSONObject obj = new JSONObject(responseJson);
            if (obj.has("_status")) {
                statusCode = obj.getInt("_status");
                obj.remove("_status");
                responseJson = obj.toString();
            }
        } catch (Exception ignored) {}
        writeJson(out, statusCode, responseJson);
    }

    private void handleWebSocket(Socket socket, BufferedInputStream in, OutputStream out, Request req) throws Exception {
        socket.setSoTimeout(0);
        String key = req.headers.get("sec-websocket-key");
        if (key == null || key.isEmpty()) {
            writeResponse(out, 400, "text/plain; charset=utf-8", "Missing websocket key");
            return;
        }
        MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
        String accept = Base64.encodeToString(sha1.digest((key + WS_GUID).getBytes(StandardCharsets.US_ASCII)), Base64.NO_WRAP);
        String response = "HTTP/1.1 101 Switching Protocols\r\n"
            + "Upgrade: websocket\r\n"
            + "Connection: Upgrade\r\n"
            + "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";
        out.write(response.getBytes(StandardCharsets.US_ASCII));
        out.flush();
        WsClient client = new WsClient(socket, out);
        client.readLoop(in);
    }

    private Request readRequest(BufferedInputStream in) throws IOException {
        String requestLine = readLine(in);
        if (requestLine == null || requestLine.trim().isEmpty()) return null;
        String[] parts = requestLine.split(" ");
        if (parts.length < 2) return null;
        Request req = new Request();
        req.method = parts[0].toUpperCase(Locale.ROOT);
        req.pathWithQuery = parts[1];
        req.path = req.pathWithQuery.split("\\?", 2)[0];
        String line;
        while ((line = readLine(in)) != null && line.length() > 0) {
            int colon = line.indexOf(':');
            if (colon > 0) {
                req.headers.put(line.substring(0, colon).trim().toLowerCase(Locale.ROOT), line.substring(colon + 1).trim());
            }
        }
        int len = 0;
        try { len = Integer.parseInt(req.headers.getOrDefault("content-length", "0")); } catch (Exception ignored) {}
        if (len > 0) {
            byte[] body = readExact(in, len);
            req.body = new String(body, StandardCharsets.UTF_8);
        }
        return req;
    }

    private static boolean isWebSocketRequest(Request req) {
        String upgrade = req.headers.getOrDefault("upgrade", "");
        return "websocket".equalsIgnoreCase(upgrade);
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        int b;
        while ((b = in.read()) != -1) {
            if (b == '\r') continue;
            if (b == '\n') break;
            bos.write(b);
        }
        if (b == -1 && bos.size() == 0) return null;
        return bos.toString("UTF-8");
    }

    private static byte[] readExact(InputStream in, int len) throws IOException {
        byte[] data = new byte[len];
        int off = 0;
        while (off < len) {
            int n = in.read(data, off, len - off);
            if (n < 0) throw new IOException("Unexpected EOF");
            off += n;
        }
        return data;
    }

    private static void writeJson(OutputStream out, int status, String json) throws IOException {
        writeResponse(out, status, "application/json; charset=utf-8", json != null ? json : "{}");
    }

    private static void writeResponse(OutputStream out, int status, String contentType, String body) throws IOException {
        byte[] bytes = (body != null ? body : "").getBytes(StandardCharsets.UTF_8);
        String header = "HTTP/1.1 " + status + " " + reason(status) + "\r\n"
            + "Content-Type: " + contentType + "\r\n"
            + "Content-Length: " + bytes.length + "\r\n"
            + "Access-Control-Allow-Origin: *\r\n"
            + "Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS\r\n"
            + "Access-Control-Allow-Headers: Content-Type, Authorization, X-Player-Id\r\n"
            + "Access-Control-Allow-Private-Network: true\r\n"
            + "Connection: close\r\n\r\n";
        out.write(header.getBytes(StandardCharsets.US_ASCII));
        out.write(bytes);
        out.flush();
    }

    private static String reason(int status) {
        switch (status) {
            case 200: return "OK";
            case 201: return "Created";
            case 204: return "No Content";
            case 400: return "Bad Request";
            case 401: return "Unauthorized";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 409: return "Conflict";
            case 500: return "Internal Server Error";
            default: return status >= 500 ? "Server Error" : "OK";
        }
    }

    private static class Request {
        String method = "GET";
        String path = "/";
        String pathWithQuery = "/";
        String body = "{}";
        Map<String, String> headers = new HashMap<>();
    }

    private class WsClient {
        final Socket socket;
        final OutputStream out;
        String roomId;

        WsClient(Socket socket, OutputStream out) {
            this.socket = socket;
            this.out = out;
        }

        void readLoop(InputStream in) {
            try {
                while (running.get() && !socket.isClosed()) {
                    String text = readWsText(in);
                    if (text == null) break;
                    handleWsText(text);
                }
            } catch (Exception e) {
                Log.w(TAG, "ws read failed: " + e.getMessage());
            } finally {
                close();
            }
        }

        void handleWsText(String text) {
            try {
                JSONObject json = new JSONObject(text);
                String type = json.optString("type");
                if ("subscribe".equals(type)) {
                    removeFromRoom();
                    roomId = json.optString("roomId", "").toLowerCase(Locale.ROOT);
                    roomClients.computeIfAbsent(roomId, k -> Collections.synchronizedSet(new LinkedHashSet<>())).add(this);
                    sendText("{\"type\":\"subscribed\",\"roomId\":\"" + roomId + "\",\"role\":\"guest\"}");
                    sendBattleSnapshot();
                } else if ("ping".equals(type)) {
                    sendText("{\"type\":\"pong\"}");
                } else if ("action".equals(type) || "gameOver".equals(type)) {
                    if (roomId != null) engine.processRequest("POST", "/api/rooms/" + roomId + "/battle", text, "{}");
                } else if ("roomAction".equals(type)) {
                    String action = json.optString("action", "");
                    if (roomId != null && !roomId.isEmpty()) {
                        try {
                            JSONObject leaveBody = new JSONObject();
                            leaveBody.put("action", action);
                            leaveBody.put("playerId", json.optString("playerId", ""));
                            leaveBody.put("playerName", json.optString("playerName", ""));
                            engine.processRequest("POST", "/api/rooms/" + roomId + "/actions", leaveBody.toString(), "{}");
                        } catch (Exception ignored) {}
                    }
                } else if ("rpc".equals(type)) {
                    String requestId = json.optString("requestId", "");
                    String method = json.optString("method", "");
                    JSONObject dataObj = json.optJSONObject("data");
                    if (dataObj == null) dataObj = new JSONObject();
                    handleRpcRequest(requestId, method, dataObj);
                }
            } catch (Exception e) {
                Log.w(TAG, "ws message failed: " + e.getMessage());
            }
        }

        void handleRpcRequest(String requestId, String method, JSONObject data) {
            try {
                String httpMethod;
                String path;
                String body = data.toString();

                switch (method) {
                    case "rooms.list":
                        httpMethod = "GET"; path = "/api/rooms"; body = "{}"; break;
                    case "rooms.get":
                        httpMethod = "GET"; path = "/api/rooms/" + data.optString("roomId", ""); body = "{}"; break;
                    case "rooms.create":
                        httpMethod = "POST"; path = "/api/rooms"; break;
                    case "rooms.action":
                        httpMethod = "POST"; path = "/api/rooms/" + data.optString("roomId", "") + "/actions"; break;
                    case "rooms.delete":
                        httpMethod = "DELETE"; path = "/api/rooms/" + data.optString("roomId", ""); break;
                    case "rooms.spectate":
                        sendRpcResult(requestId, true, new JSONObject(), null);
                        return;
                    case "gameRecord.get":
                        httpMethod = "GET"; path = "/api/rooms/" + data.optString("roomId", "") + "/game-record"; body = "{}"; break;
                    case "gameRecord.sign":
                        httpMethod = "POST"; path = "/api/rooms/" + data.optString("roomId", "") + "/game-record"; break;
                    default:
                        sendRpcResult(requestId, false, null, "Unknown RPC method: " + method);
                        return;
                }

                String responseJson = engine.processRequest(httpMethod, path, body, "{}");
                JSONObject responseObj;
                try { responseObj = new JSONObject(responseJson != null ? responseJson : "{}"); }
                catch (Exception e) { responseObj = new JSONObject(); }

                int status = 200;
                if (responseObj.has("_status")) {
                    status = responseObj.optInt("_status", 200);
                    responseObj.remove("_status");
                }

                if (status >= 400) {
                    sendRpcResult(requestId, false, null, responseObj.optString("error", "Request failed"));
                } else {
                    sendRpcResult(requestId, true, responseObj, null);
                }
            } catch (Exception e) {
                try { sendRpcResult(requestId, false, null, e.getMessage()); } catch (Exception ignored) {}
            }
        }

        void sendRpcResult(String requestId, boolean ok, JSONObject data, String error) throws Exception {
            JSONObject result = new JSONObject();
            result.put("type", "rpcResult");
            result.put("requestId", requestId);
            result.put("ok", ok);
            if (ok && data != null) result.put("data", data);
            if (!ok && error != null) result.put("error", error);
            sendText(result.toString());
        }

        void sendBattleSnapshot() {
            if (roomId == null || roomId.isEmpty()) return;
            try {
                String response = engine.processRequest("GET", "/api/rooms/" + roomId + "/battle?since=-1", "{}", "{}");
                JSONObject payload = new JSONObject(response != null ? response : "{}");
                if (payload.has("_status") && payload.optInt("_status", 200) >= 400) return;
                payload.put("type", "battleSnapshot");
                sendText(payload.toString());
            } catch (Exception e) {
                Log.w(TAG, "send battle snapshot failed: " + e.getMessage());
            }
        }

        synchronized void sendText(String text) {
            try {
                byte[] payload = (text != null ? text : "").getBytes(StandardCharsets.UTF_8);
                out.write(0x81);
                if (payload.length < 126) {
                    out.write(payload.length);
                } else if (payload.length <= 65535) {
                    out.write(126);
                    out.write((payload.length >> 8) & 0xff);
                    out.write(payload.length & 0xff);
                } else {
                    out.write(127);
                    for (int i = 7; i >= 0; i--) out.write((payload.length >> (8 * i)) & 0xff);
                }
                out.write(payload);
                out.flush();
            } catch (Exception e) {
                close();
            }
        }

        synchronized void sendPong(byte[] payload) {
            try {
                byte[] data = payload != null ? payload : new byte[0];
                out.write(0x8A);
                out.write(data.length);
                out.write(data);
                out.flush();
            } catch (Exception e) {
                close();
            }
        }

        String readWsText(InputStream in) throws IOException {
            int b0 = in.read();
            if (b0 < 0) return null;
            int b1 = in.read();
            if (b1 < 0) return null;
            int opcode = b0 & 0x0f;
            boolean masked = (b1 & 0x80) != 0;
            long len = b1 & 0x7f;
            if (len == 126) {
                len = ((long) in.read() << 8) | in.read();
            } else if (len == 127) {
                len = 0;
                for (int i = 0; i < 8; i++) len = (len << 8) | in.read();
            }
            byte[] mask = masked ? readExact(in, 4) : new byte[0];
            if (len > 1024 * 1024) throw new IOException("WebSocket frame too large");
            byte[] payload = readExact(in, (int) len);
            if (masked) {
                for (int i = 0; i < payload.length; i++) payload[i] = (byte) (payload[i] ^ mask[i % 4]);
            }
            if (opcode == 0x8) return null;
            if (opcode == 0x9) {
                sendPong(payload);
                return "";
            }
            if (opcode != 0x1) return "";
            return new String(payload, StandardCharsets.UTF_8);
        }

        void close() {
            removeFromRoom();
            try { socket.close(); } catch (Exception ignored) {}
        }

        void removeFromRoom() {
            if (roomId != null) {
                Set<WsClient> clients = roomClients.get(roomId);
                if (clients != null) clients.remove(this);
                roomId = null;
            }
        }
    }
}
