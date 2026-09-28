package dev.appvanta.input;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.view.MotionEvent;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.TextView;

/** Shell-only fixture that exposes the maximum simultaneous pointer count. */
public final class GestureActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        FrameLayout root = new FrameLayout(this);
        TextView result = new TextView(this);
        result.setText("Pointers: 0"); result.setTextSize(24); result.setTextColor(Color.WHITE); result.setBackgroundColor(Color.DKGRAY);
        root.addView(result, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        final int[] maximum = {0};
        result.setOnTouchListener((View view, MotionEvent event) -> {
            if (event.getActionMasked() == MotionEvent.ACTION_DOWN) maximum[0] = 0;
            maximum[0] = Math.max(maximum[0], event.getPointerCount());
            result.setText("Pointers: " + maximum[0]);
            return true;
        });
        setContentView(root);
    }
}
