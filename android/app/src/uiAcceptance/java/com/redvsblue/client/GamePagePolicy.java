package com.redvsblue.client;

import java.net.URI;
import java.util.Set;

final class GamePagePolicy {
    static final String CSP = "script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'self' http: https: ws: wss:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
    static boolean localOrigin(String raw) {
        try {
            URI uri = new URI(raw);
            return "https".equals(uri.getScheme()) && "localhost".equals(uri.getHost()) && uri.getPort() == -1 && uri.getRawUserInfo() == null;
        } catch (Exception error) { return false; }
    }
    static boolean trustedPage(String raw, Set<String> pages) {
        if (!localOrigin(raw)) return false;
        try {
            URI uri = new URI(raw);
            String path = uri.getRawPath();
            if (path == null || path.isEmpty() || path.equals("/")) path = "/index.html";
            return path.startsWith("/") && pages.contains(path.substring(1));
        } catch (Exception error) { return false; }
    }
}
