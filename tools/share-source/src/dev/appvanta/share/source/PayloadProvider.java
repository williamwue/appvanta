package dev.appvanta.share.source;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;

public final class PayloadProvider extends ContentProvider {
    public boolean onCreate() { return true; }
    private File file(Uri uri) {
        if (!"dev.appvanta.share.source".equals(uri.getAuthority()) || uri.getPathSegments().size() != 2
                || !"payload".equals(uri.getPathSegments().get(0)) || !uri.getLastPathSegment().matches("[a-f0-9-]{36}")) throw new IllegalArgumentException("Invalid payload URI");
        return new File(getContext().getFilesDir(), uri.getLastPathSegment() + ".bin");
    }
    public String getType(Uri uri) { file(uri); return "application/octet-stream"; }
    public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
        File file = file(uri);
        MatrixCursor cursor = new MatrixCursor(new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE });
        cursor.addRow(new Object[] { "fixture.bin", file.length() }); return cursor;
    }
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new SecurityException("Read only");
        return ParcelFileDescriptor.open(file(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }
    public Uri insert(Uri uri, ContentValues values) { throw new SecurityException("Read only"); }
    public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new SecurityException("Read only"); }
    public int delete(Uri uri, String selection, String[] args) { throw new SecurityException("Read only"); }
}
