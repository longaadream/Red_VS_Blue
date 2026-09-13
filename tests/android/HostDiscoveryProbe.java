package com.redvsblue.client;

import java.io.*;
import org.json.JSONObject;

/** Run with app_process on an emulator; exercises Android's real AtomicFile. */
public class HostDiscoveryProbe {
    public static void main(String[] args) throws Exception {
        File target = new File(args[0]);
        JSONObject first = HostDiscoveryInfo.read(target);
        String id = first.getString("serverId");
        HostDiscoveryInfo.rename(target, "\u00a0\u3000同名主机\u3000");
        JSONObject renamed = HostDiscoveryInfo.read(target);
        if (!id.equals(renamed.getString("serverId")) || !"同名主机".equals(renamed.getString("serverName"))) throw new AssertionError("rename changed identity or whitespace");
        for (String invalid : new String[] {"", "\u00a0", "\u3000", "a\nb", "\u202eabc"}) {
            try { HostDiscoveryInfo.rename(target, invalid); throw new AssertionError("accepted invalid name"); }
            catch (IOException expected) { /* Name rejected. */ }
        }
        File backup = new File(target.getPath() + ".bak");
        if (!target.renameTo(backup)) throw new AssertionError("could not simulate interrupted write");
        JSONObject restored = HostDiscoveryInfo.read(target);
        if (!id.equals(restored.getString("serverId")) || !"同名主机".equals(restored.getString("serverName"))) throw new AssertionError("backup recovery changed identity");
        System.out.println("RED204_ANDROID_PASS " + restored);
    }
}
