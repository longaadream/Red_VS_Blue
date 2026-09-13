package com.redvsblue.client;

import android.content.Context;
import android.util.AtomicFile;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.json.JSONObject;

/** Public host label; deliberately separate from player authentication and saves. */
final class HostDiscoveryInfo {
    static File file(Context context) { return new File(context.getFilesDir(), "host-discovery.json"); }
    static String name(String value) throws IOException {
        if (value == null || value.matches("(?s).*[\\p{Cc}\\p{Cf}].*")) throw new IOException("主机名称不能含控制字符");
        String result = value.replaceAll("^[\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]+|[\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]+$", "");
        if (result.isEmpty() || result.codePointCount(0, result.length()) > 32) throw new IOException("主机名称需要 1–32 个字符");
        return result;
    }
    static JSONObject read(Context context) throws Exception { return read(file(context)); }
    static synchronized JSONObject read(File target) throws Exception {
        AtomicFile file = new AtomicFile(target);
        if (!file.getBaseFile().exists() && !new File(file.getBaseFile().getPath() + ".bak").exists()) {
            write(target, new JSONObject().put("schemaVersion", 1).put("serverId", UUID.randomUUID().toString().replace("-", "")).put("serverName", "我的主机"));
        }
        JSONObject result = new JSONObject(new String(file.readFully(), StandardCharsets.UTF_8));
        if (result.getInt("schemaVersion") != 1 || !result.getString("serverId").matches("[0-9a-f]{32}")) throw new IOException("主机识别配置损坏");
        name(result.getString("serverName"));
        return result;
    }
    static void rename(Context context, String value) throws Exception { rename(file(context), value); }
    static synchronized void rename(File target, String value) throws Exception {
        String label = name(value);
        write(target, read(target).put("serverName", label));
    }
    private static void write(File target, JSONObject data) throws IOException {
        AtomicFile file = new AtomicFile(target);
        FileOutputStream output = null;
        try {
            output = file.startWrite();
            output.write(data.toString().getBytes(StandardCharsets.UTF_8));
            file.finishWrite(output);
        } catch (IOException error) { file.failWrite(output); throw error; }
    }
}
