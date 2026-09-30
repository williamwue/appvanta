package dev.appvanta.share.helper;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import java.io.FileNotFoundException;

public final class ReceiptProvider extends ContentProvider {
    public boolean onCreate() { return true; }
    public String getType(Uri uri) { return "application/json"; }
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode) || !"dev.appvanta.share.helper".equals(uri.getAuthority()) || uri.getPathSegments().size() != 2 || !"operations".equals(uri.getPathSegments().get(0)) || uri.getQuery() != null || uri.getFragment() != null) throw new FileNotFoundException("Invalid receipt path or mode");
        return ParcelFileDescriptor.open(Receipts.file(getContext(), uri.getPathSegments().get(1)), ParcelFileDescriptor.MODE_READ_ONLY);
    }
    public Cursor query(Uri uri, String[] projection, String selection, String[] arguments, String sortOrder) { throw new UnsupportedOperationException("Read receipt contents instead"); }
    public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    public int update(Uri uri, ContentValues values, String selection, String[] arguments) { throw new UnsupportedOperationException(); }
    public int delete(Uri uri, String selection, String[] arguments) { throw new UnsupportedOperationException(); }
}
