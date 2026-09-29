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

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    session = getIntent().getStringExtra("session");
    if (session == null || !session.matches("[a-f0-9-]{36}")) { finish(); return; }
    try { output = openFileOutput("events-" + session + ".jsonl", MODE_PRIVATE); }
    catch (Exception error) { throw new IllegalStateException(error); }
    manager = (SensorManager)getSystemService(SENSOR_SERVICE);
    text = new TextView(this);
    text.setTextSize(20);
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
      text.setText("Acceleration events: " + samples + "\n" + event.values[0] + ":" + event.values[1] + ":" + event.values[2]);
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
