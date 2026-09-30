# Contributing to AppVanta

AppVanta accepts independently written contributions that improve mobile application development, debugging and verification.

## Development

Use Node.js 22 and install the locked dependencies:

On Windows, `npm test` also requires Python 3.11+ for the native file-sharing
fixture. Set `APPVANTA_TEST_PYTHON` if its executable is not named `python`.
This helper uses the standard library only and performs a real Win32 sharing
denial; it does not replace the production rename with a synthetic error.

```sh
npm ci
npm run build
npm test
```

Python network tests run separately:

```sh
cd scripts
python -m unittest test_proxy_recovery.py test_network_finalization.py
```

Device-dependent changes must state the device type, Android version, exact command, evidence directory and untested boundaries. Unit tests or mocked ADB output do not prove physical-device behavior.

## Independent implementation

Do not copy source, prompts, assets or restricted binaries from ARTEMIS, Argent or another reference product. Public documentation, protocol shapes, platform APIs and externally observable behavior may inform a clean implementation. A contribution derived from third-party code must identify every source file, license, copyright notice and modification before review.

Never add Argent proprietary simulator servers, AX services or dylibs. Do not commit APKs, device credentials, signing keys, network CA private keys, captured secrets or personal application data.

## Changes

- Keep core capability interfaces independent of Android-specific implementations.
- Use semantic targets before coordinates.
- Persist recovery information before changing device state.
- Preserve screenshots, UI descriptions, logs and structured results for meaningful steps.
- Mark implementation and device verification separately in documentation.
- Update the capability matrix and command documentation when public behavior changes.

Commits should be focused and explain the behavior they add or correct. Pull requests should include the problem, resulting behavior, validation commands and remaining limits.
