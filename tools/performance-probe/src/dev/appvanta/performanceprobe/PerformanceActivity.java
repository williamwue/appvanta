package dev.appvanta.performanceprobe;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Debug;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Process;
import android.os.SystemClock;
import android.util.AtomicFile;
import android.widget.TextView;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

/** Test-only deterministic CPU workload; no network or storage permissions. */
public final class PerformanceActivity extends Activity {
  private final AtomicBoolean busy = new AtomicBoolean();
  private TextView text;
  private HandlerThread worker;
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    text = new TextView(this); text.setText("Performance probe ready"); setContentView(text);
    getWindow().addFlags(128);
    worker = new HandlerThread("AppVantaCpuProbe"); worker.start();
    run(getIntent());
  }
  @Override public void onNewIntent(Intent intent) { super.onNewIntent(intent); run(intent); }
  @Override public void onDestroy() { worker.quitSafely(); super.onDestroy(); }
  private void run(Intent intent) {
    String id = intent.getStringExtra("runId");
    int iterations = intent.getIntExtra("iterations", 0);
    if (id == null || !id.matches("[a-f0-9-]{36}") || iterations < 1 || iterations > 100000000) return;
    File target = new File(getFilesDir(), "result-" + id + ".json");
    if (target.exists() || !busy.compareAndSet(false, true)) return;
    new Handler(worker.getLooper()).post(() -> {
      try {
        long start = SystemClock.elapsedRealtimeNanos(), cpuStart = Debug.threadCpuTimeNanos();
        int value = 0x12345678;
        for (int i = 0; i < iterations; i++) { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; }
        long cpu = Debug.threadCpuTimeNanos() - cpuStart, end = SystemClock.elapsedRealtimeNanos();
        JSONObject result = new JSONObject();
        result.put("version", 1); result.put("runId", id); result.put("iterations", iterations);
        result.put("checksum", Integer.toUnsignedString(value));
        result.put("pid", Process.myPid()); result.put("tid", Process.myTid());
        result.put("startElapsedNs", start); result.put("endElapsedNs", end); result.put("threadCpuNs", cpu);
        AtomicFile output = new AtomicFile(target); FileOutputStream stream = output.startWrite();
        try { stream.write(result.toString().getBytes(StandardCharsets.UTF_8)); output.finishWrite(stream); }
        catch (Exception error) { output.failWrite(stream); throw error; }
        runOnUiThread(() -> text.setText("Completed " + id));
      } catch (Exception error) { runOnUiThread(() -> text.setText("Failed: " + error)); }
      finally { busy.set(false); }
    });
  }
}
