# Security boundaries

- There is no shell, file, screen, pointer, keyboard-text, URL-opening or arbitrary-process API.
- Relay and agent both validate protocol version, command age, payload bounds and application identifiers.
- Offline devices reject commands immediately; no queue is persisted.
- Production accepts state-changing HTTP requests only from the configured origin.
- Pairing codes expire in ten minutes. WebSocket tickets expire in 30 seconds.
- Update archives and appcasts require Sparkle EdDSA signatures. The signing private key remains in the developer Mac Keychain.
- Runtime secrets belong in a mode-`600` server environment file. Never commit databases, `.env` files, recovery codes or private keys.

Report security issues privately to the repository owner rather than opening a public issue with exploit details.
