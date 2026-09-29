# AppVanta Sensor Probe

Test-only Android app that records accelerometer callbacks to a session-specific internal JSONL file. It is debuggable so the verifier can read the file with `adb run-as`; it requests no storage or network permissions. Each session records at most 4000 samples, with the Android sensor timestamp and three acceleration axes.

Build with `python scripts/build-segment-clock.py --fixture sensor-probe --sdk <sdk>`, then run `node scripts/verify-sensor-events.mjs <emulator>`. Build Tools 35.0.0, the Android 35 platform and a JDK are required. Generated APKs and the local debug signing key remain under ignored `.appvanta/sensor-probe/`.

The verifier installs or updates this test package, leaves its APK installed, and stops its activity after sampling. It retains the original JSONL, APK hash, sensor recovery record and summary. A signing mismatch fails installation; the verifier does not uninstall an existing package to bypass it.

Receiving both acceleration directions demonstrates application callback delivery. It does not prove the behavior of every application's shake detector, physical device motion, or OEM sensor behavior.
