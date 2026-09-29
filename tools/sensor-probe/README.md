# AppVanta Sensor Probe

Test-only Android app that records accelerometer callbacks to a session-specific internal JSONL file. It is debuggable so the verifier can read the file with `adb run-as`; it requests no storage or network permissions. Each session records at most 4000 samples, with the Android sensor timestamp and three acceleration axes.

Build with `python scripts/build-segment-clock.py --fixture sensor-probe --sdk <sdk>`, then run `node scripts/verify-sensor-events.mjs <emulator>`. Build Tools 35.0.0, the Android 35 platform and a JDK are required. Generated APKs and the local debug signing key remain under ignored `.appvanta/sensor-probe/`.

The verifier installs or updates this test package, leaves its APK installed, and stops its activity after sampling. It retains the original JSONL, APK hash, sensor recovery record and summary. A signing mismatch fails installation; the verifier does not uninstall an existing package to bypass it.

The reference detector captures the first callback as a stationary baseline. Two opposite peaks of at least 8 m/s² on the same axis within 1.5 seconds trigger a detection, with a 300 ms cooldown. It emits a `shake` event and updates the visible detection count. This intentionally simple fixture does not estimate changing gravity or device orientation.

The verifier checks a quiet baseline with zero detections, injects alternating acceleration, and compares the detector events with actual UI XML and screenshots. To select another axis, use `node scripts/verify-sensor-events.mjs <emulator> <apk> y` (or `z`). Each invocation starts a new session and restores the original acceleration. Raw callbacks, idle events, UI evidence and detection events are retained.

This verifies application callback delivery and this reference detector's UI response. It does not prove the behavior of every application's shake detector, physical device motion, or OEM sensor behavior.
