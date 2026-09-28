# Third-party notices

AppVanta is independently implemented. The ARTEMIS and Argent repositories are design and behavior references only; their source code and binaries are not included in this repository or in AppVanta packages.

## JavaScript packages

The current lockfile contains the following external packages:

| Package | Version | License | Use |
|---|---:|---|---|
| `@types/node` | 22.20.2 | MIT | development |
| `@types/pngjs` | 6.0.5 | MIT | development types for PNG comparison |
| `typescript` | 5.9.2 | Apache-2.0 | development |
| `ajv` | 8.20.0 | MIT | MCP JSON Schema validation |
| `fast-deep-equal` | 3.1.3 | MIT | transitive through Ajv |
| `fast-uri` | 3.1.8 | BSD-3-Clause | transitive through Ajv |
| `json-schema-traverse` | 1.0.0 | MIT | transitive through Ajv |
| `require-from-string` | 2.0.2 | MIT | transitive through Ajv |
| `pngjs` | 7.0.0 | MIT | PNG screenshot decoding and diff generation |
| `undici-types` | 6.21.0 | MIT | transitive development types |
| `yaml` | 2.8.3 | ISC | strict CLI YAML Flow parsing |

## Optional Python runtime packages

Network capture and Perfetto analysis are installed separately by the operator:

| Package | Pinned version | Purpose |
|---|---:|---|
| `mitmproxy` | 11.0.2 | request-level network capture |
| `perfetto` | 0.58.2 | trace processing |
| `protobuf` | 7.36.1 | Perfetto dependency pinned by AppVanta |

Their license texts and transitive dependency notices must be collected from the installed distributions when producing a binary or self-contained release. The source repository does not vendor these Python distributions.

## Reference products excluded from distribution

- ARTEMIS baseline: commit `371aa6df56880643da57b30da936e9812fb0ec66`, Apache-2.0. ARTEMIS states that it contains source developed by Minitap, Inc.; none of that source is incorporated here.
- Argent baseline: `@swmansion/argent@0.25.2`, commit `37fe85a0cc1a88b80023fe5705312f66912cf431`. Argent source is Apache-2.0, while its simulator server, AX service and native-devtools iOS dylibs are proprietary. None of those artifacts is incorporated, executed or redistributed here.

Before each release, regenerate this inventory from the exact lockfiles and packaged files. This document is an engineering inventory and does not replace the license files shipped by dependencies.
