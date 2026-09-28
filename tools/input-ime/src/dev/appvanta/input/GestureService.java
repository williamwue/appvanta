package dev.appvanta.input;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Build;
import android.system.Os;
import android.util.Base64;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.BufferedWriter;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/** User-enabled test-device bridge for real simultaneous multi-touch gestures. */
public final class GestureService extends AccessibilityService {
    private final ExecutorService recordingWrites = Executors.newSingleThreadExecutor();
    private final Set<String> recordingPackages = new HashSet<>();
    private volatile boolean recording;
    private boolean recordText;
    private String recordingId;
    private volatile String recordingError;
    private BufferedWriter recordingWriter;
    private int recordingSequence;
    private static final String ACTIVE_RECORDING = "active-recording.json";

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            setResultCode(0);
            if ("dev.appvanta.input.START_RECORDING".equals(intent.getAction())) { startRecording(intent); return; }
            if ("dev.appvanta.input.STOP_RECORDING".equals(intent.getAction())) { stopRecording(intent); return; }
            if ("dev.appvanta.input.PASTE".equals(intent.getAction())) { pasteFocusedNode(); return; }
            if (!"dev.appvanta.input.DISPATCH_GESTURE".equals(intent.getAction())) { setResultData("invalid-action"); return; }
            String payload = intent.getStringExtra("gesture64");
            if (payload == null || payload.length() > 65536) { setResultData("invalid-payload"); return; }
            final PendingResult pending = goAsync();
            try {
                JSONObject root = new JSONObject(new String(Base64.decode(payload, Base64.NO_WRAP), StandardCharsets.UTF_8));
                int duration = root.getInt("durationMs");
                JSONArray strokes = root.getJSONArray("strokes");
                if (duration < 100 || duration > 60000 || strokes.length() < 2 || strokes.length() > 10) throw new IllegalArgumentException("invalid-bounds");
                GestureDescription.Builder gesture = new GestureDescription.Builder();
                for (int index = 0; index < strokes.length(); index++) {
                    JSONArray points = strokes.getJSONObject(index).getJSONArray("points");
                    if (points.length() < 2 || points.length() > 50) throw new IllegalArgumentException("invalid-points");
                    Path path = new Path();
                    for (int point = 0; point < points.length(); point++) {
                        JSONObject value = points.getJSONObject(point);
                        int x = value.getInt("x"), y = value.getInt("y");
                        if (x < 0 || y < 0 || x > 100000 || y > 100000) throw new IllegalArgumentException("invalid-coordinate");
                        if (point == 0) path.moveTo(x, y); else path.lineTo(x, y);
                    }
                    gesture.addStroke(new GestureDescription.StrokeDescription(path, 0, duration));
                }
                boolean accepted = dispatchGesture(gesture.build(), new GestureResultCallback() {
                    @Override public void onCompleted(GestureDescription description) {
                        pending.setResultCode(1); pending.setResultData("gesture-completed"); pending.finish();
                    }
                    @Override public void onCancelled(GestureDescription description) {
                        pending.setResultData("gesture-cancelled"); pending.finish();
                    }
                }, null);
                if (!accepted) { pending.setResultData("gesture-rejected"); pending.finish(); }
            } catch (Exception error) { pending.setResultData("invalid-gesture:" + error.getMessage()); pending.finish(); }
        }
    };

    @Override protected void onServiceConnected() {
        IntentFilter filter = new IntentFilter("dev.appvanta.input.DISPATCH_GESTURE");
        filter.addAction("dev.appvanta.input.START_RECORDING");
        filter.addAction("dev.appvanta.input.STOP_RECORDING");
        filter.addAction("dev.appvanta.input.PASTE");
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(receiver, filter, "android.permission.DUMP", null, Context.RECEIVER_EXPORTED);
        else registerReceiver(receiver, filter, "android.permission.DUMP", null);
        restoreRecording();
    }
    private void pasteFocusedNode() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        AccessibilityNodeInfo focused = root == null ? null : root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (focused == null) { receiver.setResultData("input-focus-missing"); return; }
        if (!focused.performAction(AccessibilityNodeInfo.ACTION_PASTE)) { receiver.setResultData("paste-rejected"); return; }
        receiver.setResultCode(1); receiver.setResultData("paste-completed");
    }
    private File recordingFile(String id) {
        File external = getExternalFilesDir(null);
        if (external == null) throw new IllegalStateException("external-storage-unavailable");
        File directory = new File(external, "recordings");
        if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("cannot-create-directory");
        return new File(directory, "manual-" + id + ".jsonl");
    }
    private File activeRecordingFile() { return new File(getFilesDir(), ACTIVE_RECORDING); }
    private void saveActiveRecording() throws Exception {
        JSONObject state = new JSONObject(); state.put("version", 1); state.put("recordingId", recordingId); state.put("includeText", recordText); state.put("sequence", recordingSequence);
        JSONArray packages = new JSONArray(); for (String value : recordingPackages) packages.put(value); state.put("packages", packages);
        File target = activeRecordingFile(), temporary = new File(getFilesDir(), ACTIVE_RECORDING + ".tmp");
        try (FileOutputStream output = new FileOutputStream(temporary, false)) { output.write(state.toString().getBytes(StandardCharsets.UTF_8)); output.getFD().sync(); }
        Os.rename(temporary.getAbsolutePath(), target.getAbsolutePath());
    }
    private void restoreRecording() {
        File stateFile = activeRecordingFile(); if (!stateFile.exists() || recordingWriter != null) return;
        try {
            StringBuilder raw = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(new FileInputStream(stateFile), StandardCharsets.UTF_8))) { String line; while ((line = reader.readLine()) != null) raw.append(line); }
            JSONObject state = new JSONObject(raw.toString());
            if (state.getInt("version") != 1) throw new IllegalStateException("invalid-recording-state-version");
            String id = state.getString("recordingId"); if (!id.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")) throw new IllegalStateException("invalid-recording-state-id");
            JSONArray packages = state.getJSONArray("packages"); if (packages.length() < 1 || packages.length() > 10) throw new IllegalStateException("invalid-recording-state-packages");
            recordingPackages.clear(); for (int index = 0; index < packages.length(); index++) { String value = packages.getString(index); if (!value.matches("[A-Za-z0-9_.]+") || !recordingPackages.add(value)) throw new IllegalStateException("invalid-recording-state-package"); }
            int sequence = state.getInt("sequence"); if (sequence < 0) throw new IllegalStateException("invalid-recording-state-sequence");
            File file = recordingFile(id); if (!file.isFile()) throw new IllegalStateException("recording-output-missing");
            recordingWriter = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(file, true), StandardCharsets.UTF_8));
            recordingId = id; recordText = state.optBoolean("includeText", false); recordingSequence = sequence; recordingError = null; recording = true;
        } catch (Exception error) { recording = false; try { if (recordingWriter != null) recordingWriter.close(); } catch (Exception ignored) {} recordingWriter = null; recordingPackages.clear(); recordingId = null; recordingError = "recording-restore-failed:" + error.getMessage(); android.util.Log.e("AppVantaRecorder", "Recording restore failed", error); }
    }
    private void startRecording(Intent intent) {
        if (recording || recordingWriter != null || activeRecordingFile().exists()) { receiver.setResultData("recording-active"); return; }
        String payload = intent.getStringExtra("config64");
        File file = null;
        try {
            if (payload == null || payload.length() > 16384) throw new IllegalArgumentException("invalid-config");
            JSONObject config = new JSONObject(new String(Base64.decode(payload, Base64.NO_WRAP), StandardCharsets.UTF_8));
            String id = config.getString("recordingId");
            if (!id.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")) throw new IllegalArgumentException("invalid-id");
            JSONArray packages = config.getJSONArray("packages");
            if (packages.length() < 1 || packages.length() > 10) throw new IllegalArgumentException("invalid-packages");
            recordingPackages.clear();
            for (int index = 0; index < packages.length(); index++) {
                String value = packages.getString(index);
                if (!value.matches("[A-Za-z0-9_.]+") || !recordingPackages.add(value)) throw new IllegalArgumentException("invalid-package");
            }
            file = recordingFile(id);
            if (file.exists()) throw new IllegalStateException("recording-exists");
            recordingWriter = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(file, false), StandardCharsets.UTF_8));
            recordingId = id; recordText = config.optBoolean("includeText", false); recordingSequence = 0; recordingError = null; recording = true;
            saveActiveRecording();
            receiver.setResultCode(1); receiver.setResultData("recording-started");
        } catch (Exception error) {
            recording = false; recordingPackages.clear(); recordingId = null; recordingError = null;
            try { if (recordingWriter != null) recordingWriter.close(); } catch (Exception ignored) {} recordingWriter = null;
            activeRecordingFile().delete(); if (file != null) file.delete();
            receiver.setResultData("recording-start-failed:" + error.getMessage());
        }
    }
    private void stopRecording(Intent intent) {
        String id = intent.getStringExtra("recordingId");
        if (recordingWriter == null && activeRecordingFile().exists()) restoreRecording();
        if (recordingWriter == null || id == null || !id.equals(recordingId)) { receiver.setResultData("recording-not-active"); return; }
        recording = false;
        final BufferedWriter writer = recordingWriter; recordingWriter = null;
        final BroadcastReceiver.PendingResult pending = receiver.goAsync();
        recordingWrites.execute(() -> {
            try {
                writer.flush(); writer.close();
                if (!activeRecordingFile().delete() && activeRecordingFile().exists()) throw new IllegalStateException("cannot-delete-recording-state");
                if (recordingError == null) { pending.setResultCode(1); pending.setResultData("recording-stopped"); }
                else pending.setResultData("recording-failed:" + recordingError);
            } catch (Exception error) { pending.setResultData("recording-stop-failed:" + error.getMessage()); }
            finally { recordingPackages.clear(); recordingId = null; recordingError = null; pending.finish(); }
        });
    }
    private static String value(CharSequence text) { return text == null ? "" : text.toString(); }
    private static String eventText(AccessibilityEvent event) {
        StringBuilder result = new StringBuilder();
        for (CharSequence part : event.getText()) { if (result.length() > 0) result.append('\n'); result.append(part); }
        return result.toString();
    }
    private static JSONObject target(AccessibilityEvent event) throws Exception {
        AccessibilityNodeInfo node = event.getSource();
        if (node == null) return null;
        int type = event.getEventType();
        if (type == AccessibilityEvent.TYPE_VIEW_CLICKED || type == AccessibilityEvent.TYPE_VIEW_LONG_CLICKED) {
            for (int depth = 0; depth < 5 && node != null && !node.isClickable(); depth++) node = node.getParent();
        }
        if (node == null) return null;
        Rect bounds = new Rect(); node.getBoundsInScreen(bounds);
        JSONObject result = new JSONObject();
        String resourceId = node.getViewIdResourceName();
        if (resourceId != null && !resourceId.isEmpty()) result.put("resourceId", resourceId);
        String description = value(node.getContentDescription()); if (!description.isEmpty()) result.put("contentDescription", description);
        String text = value(node.getText()); if (!text.isEmpty()) result.put("text", text);
        result.put("left", bounds.left); result.put("top", bounds.top); result.put("right", bounds.right); result.put("bottom", bounds.bottom);
        return result;
    }
    @Override public void onAccessibilityEvent(AccessibilityEvent event) {
        if (!recording) return;
        String packageName = value(event.getPackageName());
        if (!recordingPackages.contains(packageName)) return;
        int type = event.getEventType();
        String kind;
        if (type == AccessibilityEvent.TYPE_VIEW_CLICKED) kind = "click";
        else if (type == AccessibilityEvent.TYPE_VIEW_LONG_CLICKED) kind = "long-click";
        else if (type == AccessibilityEvent.TYPE_VIEW_SCROLLED) kind = "scroll";
        else if (type == AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED && recordText) kind = "text-change";
        else return;
        try {
            JSONObject record = new JSONObject();
            record.put("version", 1); record.put("sequence", ++recordingSequence); record.put("timestamp", System.currentTimeMillis()); record.put("kind", kind); record.put("packageName", packageName);
            JSONObject target = target(event); if (target != null) record.put("target", target);
            if (type == AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED) { record.put("beforeText", value(event.getBeforeText())); record.put("afterText", eventText(event)); }
            if (type == AccessibilityEvent.TYPE_VIEW_SCROLLED && Build.VERSION.SDK_INT >= 28) { record.put("scrollDeltaX", event.getScrollDeltaX()); record.put("scrollDeltaY", event.getScrollDeltaY()); }
            saveActiveRecording();
            final String line = record.toString();
            final BufferedWriter writer = recordingWriter;
            recordingWrites.execute(() -> {
                try { if (writer != null) { writer.write(line); writer.newLine(); writer.flush(); } }
                catch (Exception error) { android.util.Log.e("AppVantaRecorder", "Recording write failed", error); recording = false; recordingError = error.getMessage(); }
            });
        } catch (Exception error) { android.util.Log.e("AppVantaRecorder", "Event serialization failed", error); recording = false; recordingError = error.getMessage(); }
    }
    @Override public void onInterrupt() {}
    @Override public void onDestroy() {
        recording = false;
        final BufferedWriter writer = recordingWriter; recordingWriter = null;
        recordingWrites.execute(() -> { try { if (writer != null) { writer.flush(); writer.close(); } } catch (Exception ignored) {} });
        recordingWrites.shutdown();
        try { unregisterReceiver(receiver); } catch (IllegalArgumentException ignored) {}
        super.onDestroy();
    }
}
