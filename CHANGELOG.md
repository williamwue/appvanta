# Changelog

## Unreleased

## 0.2.0-alpha.1 - Unreleased

- Add guarded adjudicated continuation, repeated unbound lease transfer recovery, and ASCII/Unicode input replay avoidance checks.
- Verify interrupted screen and Perfetto file transfers on local API 37 and hosted API 35 emulators.
- Handle temporary Windows sharing locks when publishing monitor state.
- Establish upgrade checks against the original public 0.1.0 source snapshot. This remains an experimental candidate; packages are private and physical-device/OEM acceptance is incomplete.

- Verify Android rotation, long press, hardware buttons, power-state restoration, and Unicode clipboard paste on an API 37 emulator.
- Route paste through the explicitly enabled AppVanta Accessibility service so applications can acknowledge Android `ACTION_PASTE` instead of relying on an injected paste key event.

This project follows semantic versioning after the first public release. Dates use `YYYY-MM-DD`.

## 0.1.0 - Unreleased

Initial Android-focused development release:

- cross-platform core contracts and independent ADB Driver;
- CLI and MCP interfaces for device lifecycle, structured actions and Flow execution;
- screenshots, UI trees, Logcat, network capture, Perfetto, diagnostics and evidence reports;
- persistent tasks, cancellation, recovery, monitoring, task steering and completion events;
- independent local workers for asynchronous Flow, multi-device batches and continuous monitoring;
- multi-device scheduling, visual/run/performance baselines and portable evidence export;
- self-built Unicode input, clipboard and multi-touch Android helper;
- Accessibility interaction recording with device-side state recovery across service reconstruction.

Android emulator and local offline coverage exist. Physical-device, hosted CI and Agent-client acceptance remain release gates and are not implied by this entry.
