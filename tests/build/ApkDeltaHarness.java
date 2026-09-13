package com.redvsblue.client;

import java.io.*;
import java.nio.file.Files;
import java.util.concurrent.atomic.AtomicBoolean;

/** Invoked from Node tests against the real streaming Java implementation. */
public class ApkDeltaHarness {
    public static void main(String[] args) throws Exception {
        File base=new File(args[1]), patch=new File(args[2]), target=new File(args[3]), out=new File(args[4]);
        String targetHash=ApkDelta.hash(target,()->{}), baseHash=ApkDelta.hash(base,()->{});
        if(args[0].equals("apply")) {
            ApkDelta.apply(base,patch,out,target.length(),args.length>5?args[5]:baseHash,targetHash,()->{});
            return;
        }
        String scenario=args[0]; AtomicBoolean cancelled=new AtomicBoolean(false); int[] requests={0,0};
        ApkUpdateTransfer.Delta delta=new ApkUpdateTransfer.Delta("patch",patch.length(),ApkDelta.hash(patch,()->{}),scenario.equals("wrong-base")?"0".repeat(64):baseHash);
        try {
            String mode=ApkUpdateTransfer.run(base,out,"full",target.length(),targetHash,delta,(url,file,size)->{
                if(url.equals("patch")) {
                    requests[0]++;
                    if(scenario.equals("network-error"))throw new IOException("network failure");
                    if(scenario.equals("cancel")){cancelled.set(true);throw new IOException("cancelled");}
                    Files.copy(patch.toPath(),file.toPath());
                    if(scenario.equals("corrupt"))try(RandomAccessFile f=new RandomAccessFile(file,"rw")){f.seek(5);f.write(44);}
                } else { requests[1]++; Files.copy(target.toPath(),file.toPath()); }
            },file->{if(scenario.equals("bad-signature"))throw new IOException("APK signature mismatch");},()->{if(cancelled.get())throw new IOException("cancelled");},message->{});
            if(scenario.equals("cancel")||scenario.equals("bad-signature"))throw new AssertionError("Should reject");
            if(Files.mismatch(target.toPath(),new File(out,"candidate.apk").toPath()) != -1L)throw new AssertionError("Target differs");
            System.out.println(mode+":"+requests[0]+":"+requests[1]);
        } catch(IOException error) {
            if(!scenario.equals("cancel")&&!scenario.equals("bad-signature"))throw error;
            if(new File(out,"candidate.apk").exists())throw new AssertionError("Invalid candidate retained");
            if(scenario.equals("cancel") && requests[1]!=0)throw new AssertionError("Cancellation triggered fallback");
            System.out.println("rejected:"+requests[0]+":"+requests[1]);
        }
        if(new File(out,"patch.part").exists()||new File(out,"download.part").exists())throw new AssertionError("Partial cache retained");
    }
}
