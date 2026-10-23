# Matrix Query Shared Runtime

All three Matrix plugins start the same MCP server implementation from `scripts/matrix-mcp-server.mjs`. Their plugin entrypoints pass a slot (`hnxk`, `wz`, or `zy`); `scripts/launch.mjs` resolves that slot to a profile and sets the profile cache directory and starts the server with permanent metadata caching.

## Configuration

Run `node scripts/config-ui-server.mjs` and open `http://127.0.0.1:4178` to manage endpoints, environment and default targets, credentials, proxies, search instance scopes, and cache directories. Metadata is cached permanently; the Cache page exposes one button to refresh all visible environments, instances, databases, and tables. Environment options are loaded from the selected endpoint; choosing an environment loads its instances, and choosing an instance loads its databases. New profiles can be assigned to any of the three existing plugin slots. The slots are entrypoint bindings, not separate implementations. Restart the affected plugin after changing its assignment or connection settings.

Profiles are stored at `config/profiles.json` with mode `0600`. Password fields are write-only in the UI: stored values are never returned by the configuration API. Each profile has its own metadata and session cache directory.

## Runtime

- `scripts/launch.mjs`: profile and slot selection, environment setup, shared server startup.
- `scripts/matrix-mcp-server.mjs`: one implementation of all Matrix tools.
- `scripts/matrix-client.mjs`: endpoint, authentication, proxy, and query transport.
- `scripts/matrix-metadata-cache.mjs` and `scripts/matrix-session-cache.mjs`: profile-scoped cache behavior.
- `scripts/config-ui-server.mjs` and `ui/config.html`: local configuration UI and API.

Login passwords follow the endpoint's advertised password mode: mode `0` uses SHA1 and mode `1` uses RSA PKCS#1 v1.5 with the endpoint-provided public key.

MCP plugin manifests point directly to this shared runtime; plugin cache directories do not own active server code.
