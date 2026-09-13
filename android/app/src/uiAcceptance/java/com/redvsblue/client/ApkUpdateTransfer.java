package com.redvsblue.client;

import java.io.File;
import java.io.IOException;

/** One transaction shared by the native bridge and fault-injection tests. */
public final class ApkUpdateTransfer {
    public interface Download { void get(String url, File target, long size) throws Exception; }
    public interface Validate { void check(File apk) throws Exception; }
    public interface Progress { void set(String message); }
    public static final class Delta {
        public final String url, sha256, baseSha256;
        public final long size;
        public Delta(String url, long size, String sha256, String baseSha256) {
            this.url=url; this.size=size; this.sha256=sha256; this.baseSha256=baseSha256;
        }
    }
    private ApkUpdateTransfer() {}
    private static void remove(File file) throws IOException {
        if (file.exists() && !file.delete()) throw new IOException("Cannot clear update cache: " + file.getName());
    }
    public static String run(File base, File directory, String url, long size, String hash, Delta delta,
                             Download download, Validate validate, ApkDelta.Guard guard, Progress progress) throws Exception {
        if (size < 1 || size > ApkDelta.MAX_APK) throw new IOException("Invalid APK size");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Cannot create update cache");
        File candidate = new File(directory,"candidate.apk"), partial = new File(directory,"download.part"), patch = new File(directory,"patch.part");
        remove(candidate); remove(partial); remove(patch);
        boolean ready = false;
        try {
            String mode = "full";
            if (delta != null && delta.size > 0 && delta.size < size) {
                try {
                    guard.check();
                    if (!ApkDelta.hash(base, guard).equals(delta.baseSha256)) throw new IOException("Delta base mismatch");
                    progress.set("正在下载差量补丁"); download.get(delta.url, patch, delta.size);
                    if (patch.length()!=delta.size || !ApkDelta.hash(patch,guard).equals(delta.sha256)) throw new IOException("Delta download hash mismatch");
                    progress.set("正在合成新版 APK");
                    ApkDelta.apply(base,patch,partial,size,delta.baseSha256,hash,guard);
                    validate.check(partial); mode = "delta";
                } catch (Exception failure) {
                    // Cancellation/page teardown must never start the fallback transfer.
                    guard.check(); remove(partial);
                    progress.set("差量不可用，改为完整下载：" + failure.getMessage());
                }
            }
            if (!"delta".equals(mode)) {
                guard.check(); download.get(url,partial,size);
                if (partial.length()!=size || !ApkDelta.hash(partial,guard).equals(hash)) throw new IOException("APK download hash mismatch");
                validate.check(partial);
            }
            guard.check(); if (!partial.renameTo(candidate)) throw new IOException("Cannot save verified APK");
            ready = true; progress.set("下载校验完成，可以安装"); return mode;
        } finally {
            remove(partial); remove(patch); if (!ready) remove(candidate);
        }
    }
}
