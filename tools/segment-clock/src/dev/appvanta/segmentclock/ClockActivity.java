package dev.appvanta.segmentclock;

import android.app.Activity;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.View;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import java.util.zip.CRC32;

/** Test-only visible clock. The 16x16 square is eight payload rows and eight inverse rows. */
public final class ClockActivity extends Activity {
  private static final long REDRAW_DELAY_MS = 100;

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().getDecorView().setSystemUiVisibility(5894 | 1024 | 512);
    getWindow().addFlags(128);
    setContentView(new ClockView());
  }

  private final class ClockView extends View {
    private final Paint paint = new Paint();
    private long frame;
    ClockView() { super(ClockActivity.this); paint.setAntiAlias(false); }
    @Override protected void onDraw(Canvas canvas) {
      super.onDraw(canvas);
      canvas.drawColor(Color.BLACK);
      long millis = SystemClock.elapsedRealtimeNanos() / 1000000L;
      byte[] bytes = new byte[16];
      bytes[0] = (byte) 0xA6; bytes[1] = (byte) 0x5C;
      for (int i = 0; i < 6; i++) bytes[2 + i] = (byte) (millis >>> (40 - 8 * i));
      for (int i = 0; i < 4; i++) bytes[8 + i] = (byte) (frame >>> (24 - 8 * i));
      CRC32 crc = new CRC32(); crc.update(bytes, 0, 12);
      long checksum = crc.getValue();
      for (int i = 0; i < 4; i++) bytes[12 + i] = (byte) (checksum >>> (24 - 8 * i));
      int side = Math.min(getWidth(), getHeight());
      for (int row = 0; row < 16; row++) for (int col = 0; col < 16; col++) {
        int bit = 7 - (col % 8);
        boolean value = ((bytes[(row % 8) * 2 + col / 8] >>> bit) & 1) != 0;
        if (row >= 8) value = !value;
        paint.setColor(value ? Color.WHITE : Color.BLACK);
        canvas.drawRect(col * side / 16f, row * side / 16f,
            (col + 1) * side / 16f, (row + 1) * side / 16f, paint);
      }
      frame++;
      postInvalidateDelayed(REDRAW_DELAY_MS);
    }
  }
}
