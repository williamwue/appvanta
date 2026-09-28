# Security policy

AppVanta currently has no supported stable release line. Security fixes are applied to the latest development branch until the first public release policy is declared.

Report a suspected vulnerability through [GitHub private vulnerability reporting](https://github.com/williamwue/appvanta/security/advisories/new). This private channel is enabled for the public repository. Do not open a public issue for a security report or include device identifiers, credentials, captured request data, signing keys, CA private keys or exploit details in one.

AppVanta executes ADB commands, changes temporary device settings and can capture logs, screenshots and network metadata. Reports should identify the command or MCP tool, host platform, device platform, whether a real device was involved and the minimum reproduction that avoids personal data.

The following are expected trust boundaries rather than vulnerabilities by themselves:

- The local operator and connected ADB device are trusted.
- Flow files and MCP callers can request device actions and must come from trusted workspaces.
- Network CA private keys remain outside exported evidence.
- Recovery refuses to overwrite device state changed by another actor.
- Reference-product proprietary binaries are not part of AppVanta.
