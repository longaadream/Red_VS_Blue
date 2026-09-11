package com.redvsblue.client;
import org.junit.Test;
import org.junit.Rule;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;
import java.io.*;
import java.util.zip.*;

public class ContentFilesTest {
    @Rule public TemporaryFolder temp=new TemporaryFolder();
    private File zip(String extra)throws Exception{
        File archive=temp.newFile();try(ZipOutputStream out=new ZipOutputStream(new FileOutputStream(archive))){for(String p:new String[]{"manifest.json","signature.json",extra}){out.putNextEntry(new ZipEntry(p));out.write("{}".getBytes("UTF-8"));out.closeEntry();}}return archive;
    }
    @Test public void extractsValidTransport()throws Exception{File dir=temp.newFolder();assertEquals(3,ContentFiles.unzip(zip("data/example.json"),dir).size());assertTrue(new File(dir,"data/example.json").isFile());}
    @Test public void rejectsTraversalBeforeWriting()throws Exception{File dir=temp.newFolder();try{ContentFiles.unzip(zip("../escape.json"),dir);fail();}catch(IOException expected){}assertEquals(0,dir.list().length);}
    @Test public void rejectsCaseCollisionBeforeWriting()throws Exception{File dir=temp.newFolder();try{ContentFiles.unzip(zip("MANIFEST.JSON"),dir);fail();}catch(IOException expected){}assertEquals(0,dir.list().length);}
    @Test public void refusesMalformedDirectory()throws Exception{File archive=zip("data/a.json");try(RandomAccessFile f=new RandomAccessFile(archive,"rw")){f.setLength(f.length()-1);}try{ContentFiles.unzip(archive,temp.newFolder());fail();}catch(IOException expected){}}
    @Test public void fileAndStorageBoundaries()throws Exception{for(String path:new String[]{"/etc/a","a/../b","a\\b","x:","a//b","a/./b"}){try{ContentFiles.path(path);fail(path);}catch(IOException expected){}}try{ContentFiles.copy(new ByteArrayInputStream(new byte[100]),new ByteArrayOutputStream(),99);fail();}catch(IOException expected){}}
}
