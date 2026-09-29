package dev.appvanta.sensorprobe;

import android.app.Activity;
import android.os.Bundle;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.widget.TextView;
import org.json.JSONObject;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/** Test-only application callback evidence, read through adb run-as. */
public final class SensorActivity extends Activity implements SensorEventListener {
  private SensorManager manager;
  private FileOutputStream output;
  private String session;
  private TextView text;
  private int samples;
  private float[] baseline;
  private final int[] previousSign = new int[3];
  private final long[] previousPeak = new long[3];
  private long lastDetection;
  private int detections;

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    session = getIntent().getStringExtra("session");
    if (session == null || !session.matches("[a-f0-9-]{36}")) { finish(); return; }
    try { output = openFileOutput("events-" + session + ".jsonl", MODE_PRIVATE); }
    catch (Exception error) { throw new IllegalStateException(error); }
    manager = (SensorManager)getSystemService(SENSOR_SERVICE);
    text = new TextView(this);
    text.setTextSize(20);
    float density = getResources().getDisplayMetrics().density;
    text.setPadding((int)(16 * density), (int)(48 * density), (int)(16 * density), (int)(16 * density));
    text.setText("Waiting for acceleration events");
    setContentView(text);
    getWindow().addFlags(128);
  }

  @Override public void onResume() {
    super.onResume();
    if (manager == null) return;
    Sensor sensor = manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
    boolean registered = sensor != null && manager.registerListener(this, sensor, SensorManager.SENSOR_DELAY_GAME);
    try { emit(new JSONObject().put("type", "ready").put("registered", registered)); }
    catch (Exception error) { throw new IllegalStateException(error); }
  }

  @Override public void onSensorChanged(SensorEvent event) {
    if (samples >= 4000) return;
    try {
      emit(new JSONObject().put("type", "sample").put("timestampNanos", event.timestamp)
        .put("x", event.values[0]).put("y", event.values[1]).put("z", event.values[2]));
      samples++;
      if (baseline == null) {
        baseline = event.values.clone();
        text.setText("Shake detections: 0");
      }
      for (int axis = 0; axis < 3; axis++) {
        float delta = event.values[axis] - baseline[axis];
        if (Math.abs(delta) < 8) continue;
        int sign = delta > 0 ? 1 : -1;
        if (previousSign[axis] == -sign && event.timestamp - previousPeak[axis] <= 1500000000L
            && event.timestamp - lastDetection >= 300000000L) {
          detections++;
          lastDetection = event.timestamp;
          previousSign[axis] = 0;
          emit(new JSONObject().put("type", "shake").put("count", detections)
            .put("axis", axis).put("timestampNanos", event.timestamp));
          text.setText("Shake detections: " + detections);
        } else {
          previousSign[axis] = sign;
          previousPeak[axis] = event.timestamp;
        }
      }
    } catch (Exception error) { throw new IllegalStateException(error); }
  }

  private void emit(JSONObject value) throws Exception {
    value.put("session", session);
    output.write((value.toString() + "\n").getBytes(StandardCharsets.UTF_8));
    output.flush();
  }
  @Override public void onAccuracyChanged(Sensor sensor, int accuracy) {}
  @Override public void onPause() { if (manager != null) manager.unregisterListener(this); super.onPause(); }
  @Override public void onDestroy() {
    if (output != null) try { output.close(); } catch (Exception ignored) {}
    super.onDestroy();
  }
}
