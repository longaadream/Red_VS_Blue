package com.redvsblue.client;

import java.io.*;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.zip.GZIPInputStream;

/** Streaming reconstruction of signed APK bytes. Never modifies the installed APK. */
public final class ApkDelta {
    public static final long MAX_APK = 256L * 1024 * 1024;
    public interface Guard { void check() throws IOException; }
    private ApkDelta() {}

    public static String hash(File file, Guard guard) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[32768]; int n;
            while ((n = in.read(buffer)) != -1) { guard.check(); digest.update(buffer, 0, n); }
        }
        StringBuilder hex = new StringBuilder();
        for (byte b : digest.digest()) hex.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return hex.toString();
    }

    public static void apply(File base, File patch, File output, long size,
                             String baseHash, String targetHash, Guard guard) throws Exception {
        if (size < 1 || size > MAX_APK || base.length() > MAX_APK || patch.length() > MAX_APK
                || output.getCanonicalFile().equals(base.getCanonicalFile())
                || output.getCanonicalFile().equals(patch.getCanonicalFile())) throw new IOException("Invalid delta budget/path");
        if (!hash(base, guard).equals(baseHash)) throw new IOException("Delta base mismatch");
        boolean success = false;
        try (RandomAccessFile old = new RandomAccessFile(base, "r");
             DataInputStream in = new DataInputStream(new BufferedInputStream(new GZIPInputStream(new FileInputStream(patch))));
             FileOutputStream out = new FileOutputStream(output)) {
            byte[] magic = new byte[8]; in.readFully(magic);
            if (!Arrays.equals(magic, new byte[]{82,86,66,65,80,75,48,49}) || Integer.toUnsignedLong(in.readInt()) != size) throw new IOException("Invalid delta header");
            long written = 0; int commands = 0; byte[] buffer = new byte[32768];
            while (true) {
                guard.check(); int op = in.readUnsignedByte();
                if (op == 255) break;
                if (++commands > 131072 || (op != 0 && op != 1)) throw new IOException("Invalid delta command");
                long offset = op == 0 ? Integer.toUnsignedLong(in.readInt()) : 0;
                long length = Integer.toUnsignedLong(in.readInt());
                if (length < 1 || length > 65536 || length > size - written || (op == 0 && (offset > old.length() || length > old.length() - offset))) throw new IOException("Delta range outside APK");
                if (op == 0) old.seek(offset);
                long remaining = length;
                while (remaining > 0) {
                    guard.check(); int n = (int)Math.min(remaining, buffer.length);
                    if (op == 0) old.readFully(buffer, 0, n); else in.readFully(buffer, 0, n);
                    out.write(buffer, 0, n); remaining -= n;
                }
                written += length;
            }
            // Read to gzip EOF to validate CRC/trailer; reject appended commands/payloads.
            if (written != size || in.read() != -1) throw new IOException("Delta length/trailer mismatch");
            out.getFD().sync();
            if (!hash(output, guard).equals(targetHash)) throw new IOException("Reconstructed APK hash mismatch");
            success = true;
        } finally {
            if (!success && output.exists() && !output.delete()) throw new IOException("Cannot remove invalid delta output");
        }
    }
}
