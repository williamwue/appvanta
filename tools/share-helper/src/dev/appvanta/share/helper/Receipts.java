package dev.appvanta.share.helper;

import android.content.Context;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

final class Receipts {
    static File file(Context context, String operation) {
        if (operation == null || !operation.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")) throw new IllegalArgumentException("Invalid operation");
        return new File(context.getFilesDir(), operation + ".json");
    }
    static synchronized void create(Context context, String operation, JSONObject value) throws Exception {
        if (!file(context, operation).createNewFile()) throw new IllegalStateException("Operation already exists; inspect its receipt");
        save(context, operation, value);
    }
    static synchronized void save(Context context, String operation, JSONObject value) throws Exception {
        AtomicFile target = new AtomicFile(file(context, operation));
        FileOutputStream output = target.startWrite();
        try { output.write(value.toString().getBytes(StandardCharsets.UTF_8)); target.finishWrite(output); }
        catch (Exception error) { target.failWrite(output); throw error; }
    }
}
