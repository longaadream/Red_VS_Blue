package com.redvsblue.client;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.Normalizer;
import java.util.*;
import java.util.zip.*;

/** File policy used before ZIP extraction and again at every file boundary. */
final class ContentFiles {
    static final long ARCHIVE_LIMIT = 32L * 1024 * 1024;
    static final long FILE_LIMIT = 16L * 1024 * 1024;
    static final long TOTAL_LIMIT = 128L * 1024 * 1024;
    static String path(String value) throws IOException {
        if (value == null || value.isEmpty() || value.length() > 512 || !Normalizer.isNormalized(value, Normalizer.Form.NFC)
            || value.contains("\\") || value.contains(":") || value.matches(".*[\\x00-\\x1f\\x7f].*") || value.startsWith("/")) throw new IOException("非法资源路径");
        for (String part : value.split("/", -1)) if (part.isEmpty() || part.equals(".") || part.equals("..") || part.endsWith(".") || part.endsWith(" ")) throw new IOException("非法资源路径");
        return value;
    }
    static File child(File root, String relative) throws IOException {
        File file = new File(root, path(relative));
        if (!file.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator)) throw new IOException("路径越界");
        return file;
    }
    static long copy(InputStream input, OutputStream output, long limit) throws IOException {
        byte[] buffer = new byte[32768]; long total = 0; int count;
        while ((count = input.read(buffer)) != -1) { total += count; if (total > limit) throw new IOException("文件超过大小上限"); output.write(buffer, 0, count); }
        return total;
    }
    static byte[] read(InputStream input, long limit) throws IOException {
        try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) { copy(in, out, limit); return out.toByteArray(); }
    }
    static String hash(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(file)) { byte[] bytes = new byte[32768]; int n; while ((n = in.read(bytes)) != -1) digest.update(bytes, 0, n); }
        return hex(digest.digest());
    }
    static String hex(byte[] bytes) { StringBuilder out = new StringBuilder(); for (byte b : bytes) out.append(String.format(Locale.ROOT, "%02x", b & 255)); return out.toString(); }
    static void write(File file, byte[] bytes) throws IOException {
        if (!file.getParentFile().isDirectory() && !file.getParentFile().mkdirs()) throw new IOException("无法创建目录");
        try (FileOutputStream out = new FileOutputStream(file)) { out.write(bytes); out.getFD().sync(); }
    }
    // Only ever remove a task-owned child; never follow symbolic links.
    static void remove(File root, File file) throws IOException {
        if (!file.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator)) throw new IOException("清理路径越界");
        // Android aliases /data/data to /data/user/0; resolve the parent first,
        // then reject a link at the actual child rather than the system alias.
        if (!file.getCanonicalFile().equals(new File(file.getParentFile().getCanonicalFile(),file.getName()))) throw new IOException("不支持符号链接");
        if (file.isDirectory()) { File[] children = file.listFiles(); if (children == null) throw new IOException("无法枚举目录"); for (File c : children) remove(root, c); }
        if (file.exists() && !file.delete()) throw new IOException("无法清理临时文件");
    }
    static List<String> unzip(File archive, File destination) throws Exception {
        if (archive.length() > ARCHIVE_LIMIT) throw new IOException("资源包不得超过32MiB");
        // Central-directory preflight catches Unix links/types and encrypted entries before inflation.
        byte[] raw = read(new FileInputStream(archive),ARCHIVE_LIMIT);
        int end = -1;
        for (int p = raw.length - 22; p >= Math.max(0, raw.length - 65557); p--) {
            if (u32(raw,p) == 0x06054b50L && p + 22 + u16(raw,p+20) == raw.length) { end=p; break; }
        }
        if (end < 0 || u16(raw,end+4)!=0 || u16(raw,end+6)!=0 || u16(raw,end+8)!=u16(raw,end+10)) throw new IOException("不支持此ZIP格式");
        int entries=u16(raw,end+10); long offset=u32(raw,end+16), size=u32(raw,end+12);
        if (entries<1 || entries>2048 || offset+size!=end) throw new IOException("ZIP目录或数量非法");
        int p=(int)offset; long total=0;
        for (int i=0;i<entries;i++) {
            if (p+46>end || u32(raw,p)!=0x02014b50L) throw new IOException("ZIP目录损坏");
            int flags=u16(raw,p+8), method=u16(raw,p+10), mode=(int)(u32(raw,p+38)>>>16)&0170000;
            long count=u32(raw,p+24);
            if ((flags&1)!=0 || (method!=0 && method!=8) || (mode!=0 && mode!=0100000 && mode!=0040000) || count>FILE_LIMIT) throw new IOException("拒绝加密、链接或超限ZIP");
            total+=count; if(total>TOTAL_LIMIT) throw new IOException("解压内容超过128MiB");
            p+=46+u16(raw,p+28)+u16(raw,p+30)+u16(raw,p+32);
        }
        if(p!=end) throw new IOException("ZIP目录不一致");
        List<String> paths=new ArrayList<>(); Set<String> seen=new HashSet<>(); List<? extends ZipEntry> list;
        try(ZipFile zip=new ZipFile(archive,StandardCharsets.UTF_8)) {
            list=Collections.list(zip.entries()); if(list.size()!=entries) throw new IOException("ZIP条目不一致");
            for(ZipEntry e:list) {
                String name=e.getName(); if(e.isDirectory()) name=name.substring(0,name.length()-1);
                path(name); if(!seen.add(name.toLowerCase(Locale.ROOT))) throw new IOException("ZIP重复路径");
                if(!e.isDirectory()) paths.add(name);
            }
            if(!paths.contains("manifest.json") || !paths.contains("signature.json") || paths.contains("pack.json")) throw new IOException("请选择签名的Content Pipeline v1资源包");
            long actual=0;
            for(ZipEntry e:list) {
                if(e.isDirectory()) continue;
                File output=child(destination,e.getName()); if(!output.getParentFile().isDirectory() && !output.getParentFile().mkdirs()) throw new IOException("文件路径冲突");
                long count; CRC32 crc=new CRC32();
                try(InputStream in=new CheckedInputStream(zip.getInputStream(e),crc); FileOutputStream out=new FileOutputStream(output)) { count=copy(in,out,Math.min(FILE_LIMIT,TOTAL_LIMIT-actual)); out.getFD().sync(); }
                actual+=count; if(count!=e.getSize() || crc.getValue()!=e.getCrc()) throw new IOException("ZIP内容损坏");
            }
        }
        return paths;
    }
    private static int u16(byte[] b,int p) { if(p<0||p+2>b.length)return -1; return (b[p]&255)|((b[p+1]&255)<<8); }
    private static long u32(byte[] b,int p) { if(p<0||p+4>b.length)return -1; return (u16(b,p)&65535L)|((u16(b,p+2)&65535L)<<16); }
}
