# Runtime Compatibility Testing

Every ZClaudia agent plugin ships a `runtime-compatibility.json` descriptor. The descriptor is the
single source of truth for the executable to probe, version policy, non-network protocol check,
live end-to-end check, optional host-managed installation metadata, and whether the distributable
plugin vendors dependencies.

## Commands

Run safe, non-network checks against all locally installed CLIs:

```bash
pnpm compat:test all --report artifacts/compatibility-report.json
```

Run one runtime or override the CLI selected from `PATH`:

```bash
pnpm compat:test codex
pnpm compat:test claude --cli claude=/absolute/path/to/claude
```

Run a real model turn in an isolated temporary directory:

```bash
pnpm compat:test all --live --report artifacts/live-compatibility-report.json
```

Before publishing a plugin with `managedInstall`, stream and hash the artifact for the current
platform without installing or running it:

```bash
pnpm managed:verify codex
```

Use `--all-platforms` only in a protected release job that is expected to download every declared
artifact.

`--live` can use the provider network and the account authenticated in the local CLI. It is
intentionally opt-in. The live prompt asks the agent not to use tools, and the test uses a fresh
temporary working directory, but it may consume provider quota.

## Result states

| State                    | Meaning                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `certified`              | Static contract, CLI probe, and declared live turn all passed for the observed platform and CLI version. |
| `certified-with-warning` | The live suite passed, but the version is newer than the declared tested maximum or could not be parsed. |
| `probed`                 | Static contract and non-network CLI probe passed; no provider turn was run.                              |
| `probed-with-warning`    | Probe passed with an untested or unparseable version.                                                    |
| `incompatible`           | A contract, executable, version-policy, launch, protocol, or live-turn check failed.                     |

The report intentionally does not claim that a provider will behave identically forever. It
certifies the tested plugin version, executable version, operating system, architecture, and the
declared capability envelope.

## Adding a runtime

1. Add `agents/<runtime>/runtime-compatibility.json` using the existing descriptors as examples.
2. Declare a version command, a non-network `command` or `json-rpc` probe, and a live test.
3. Use `distribution.vendorDependencies` to tell the packer and artifact validator whether runtime
   dependencies are bundled. List required vendored packages when applicable.
4. Add adapter fixture coverage using `runAdapterConformanceSuite` from
   `scripts/runtime-conformance.mjs`.
5. Run `pnpm compat:test <runtime>` locally and attach the JSON report to the release evidence.

The test command discovers every agent directory containing this descriptor. No central agent-name
allowlist is needed for compatibility testing.

## Optional managed installation metadata

`managedInstall` is optional and backward compatible with descriptor schema version 1. It lets the
trusted ZClaudia host install a verified plugin-scoped executable when a compatible system CLI is
unavailable:

```json
{
  "managedInstall": {
    "recommendedVersion": "1.2.3",
    "authProbe": {
      "args": ["auth", "status"],
      "successExitCodes": [0],
      "unauthenticatedPattern": "login required"
    },
    "versions": [
      {
        "version": "1.2.3",
        "artifacts": {
          "darwin-arm64": {
            "url": "https://artifacts.example.invalid/agent-1.2.3-darwin-arm64.tar.gz",
            "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
            "archiveFormat": "tar.gz",
            "executablePath": "bin/agent",
            "size": 123456
          }
        }
      }
    ]
  }
}
```

The platform keys are `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, and `win32-x64`.
Artifact formats are `raw`, `zip`, and `tar.gz`. A version can override the top-level `authProbe`;
artifacts can also declare an Ed25519 detached signature and a separately hashed provenance
document.

The SHA-256 digest is mandatory. The example intentionally uses a non-resolving domain and
placeholder digest. Add provider artifacts only after the URL, version, platform, architecture,
and checksum have been verified from an authoritative provider release or a governed catalog.
Do not infer a URL pattern or copy a checksum from an unauthenticated source.

Plugins provide declarative metadata only. They must not download or execute an installer. The
host owns download approval, trust policy, locking, bounded extraction, checksum/signature checks,
version and auth probes, atomic installation, and cleanup. Provider adapters receive the resolved
`cliPath`.

The Claude and Codex descriptors include host-managed installation metadata for official immutable
GitHub release packages and their published SHA-256 values. Cursor currently omits
`managedInstall`: its official installer publishes a versioned HTTPS package URL but no
authoritative SHA-256 or signature. The host therefore reports `managed-artifact-unavailable` for
Cursor when neither a compatible system CLI nor an already-installed managed CLI exists. A future
Cursor entry must use a vendor-published digest or a governed catalog/mirror rather than treating a
locally observed download as authoritative.

## Test layers

1. `pnpm test` runs deterministic fixture tests, including the shared normalized event-stream
   contract for each adapter.
2. `pnpm compat:test` verifies the installed executable, version policy, and a safe launch or
   JSON-RPC handshake without calling a model.
3. `pnpm compat:test --live` adds one isolated real turn to validate authentication, protocol, and
   provider communication. Use it in a protected release environment with dedicated test accounts.
