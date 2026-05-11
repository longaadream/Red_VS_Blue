package com.redvsblue.client;

import android.util.Log;

import org.json.JSONObject;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;

import fi.iki.elonen.NanoHTTPD;

/**
 * Lightweight LAN HTTP server for "host" mode.
 * Receives HTTP requests from any device on the LAN and routes them to
 * GameEngineWebView for game-logic processing.
 */
public class MobileHttpServer extends NanoHTTPD {
    private static final String TAG = "MobileHttpServer";

    private final GameEngineWebView engine;

    public MobileHttpServer(int port, GameEngineWebView engine) throws IOException {
        super(port);
        this.engine = engine;
        start(NanoHTTPD.SOCKET_READ_TIMEOUT, false);
        Log.i(TAG, "Mobile HTTP server started on port " + port);
    }

    @Override
    public Response serve(IHTTPSession session) {
        String method = session.getMethod().name();
        String uri    = session.getUri();

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

        // Build a headers JSON for the JS router (auth token etc.)
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
                // Remove _status from the response body
                obj.remove("_status");
                responseJson = obj.toString();
            }
        } catch (Exception ignored) {}

        Response response = newFixedLengthResponse(
            statusFromCode(statusCode),
            "application/json; charset=utf-8",
            responseJson
        );
        // CORS — allow any origin (LAN game, all devices)
        response.addHeader("Access-Control-Allow-Origin",  "*");
        response.addHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
        response.addHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Player-Id");
        response.addHeader("Access-Control-Allow-Private-Network", "true");
        return response;
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
}
