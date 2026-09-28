# Test-only segmented-recording visual clock

Build offline with `python scripts/build-segment-clock.py`. The APK and signing key are written to ignored `.appvanta/segment-clock/`.

Run `node scripts/verify-segmented-recording.mjs <device-id> 190 --clock-fixture` to install and show the fixture before capture. Without `--clock-fixture`, the verifier keeps its Settings-screen behavior. To measure existing fixture MP4s separately, run `node scripts/measure-segment-clock.mjs <segment-1.mp4> <segment-2.mp4> ...`.

The clock view uses a square at the top-left of the full screen, with side length equal to the smaller screen dimension. Its 16-by-16 cells contain eight rows of data and eight inverse rows. The 16 payload bytes are magic `A6 5C`, a 48-bit big-endian `elapsedRealtimeNanos()/1,000,000` value, a 32-bit draw counter, and a big-endian CRC32 over the first 12 bytes. Each decoded cell is sampled at its center. Unreadable cells, mismatched inverse rows, bad magic, and bad CRC are rejected.

The view requests a redraw 100 ms after each draw (nominally 10 Hz) to reduce fixture rendering load. Every redraw reads the current monotonic millisecond clock and increments the draw counter; the clock does not advance by a fixed step or freeze when recording pauses. Android scheduling and capture can delay or omit visible updates, so decoded adjacent samples must still satisfy the decoder's 250 ms cadence limit.

The decoder extracts the first two and last two decoded frames per MP4. It checks local clock and draw-count order near each boundary, then compares the last encoded clock in one segment with the first in the next. The reported range is the sampled clock span with plus or minus one millisecond of clock quantization. Display, draw-to-capture, and encoder timing uncertainty is not bounded by this fixture. The result never proves an exact encoded gap or seamless recording.
