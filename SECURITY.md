# Security and privacy

This is a single-owner planner, not a multi-user tenant system. Everyone given the app access key can read and edit the same private workspace.

## Boundaries

- Public Git contains code, synthetic tests and dependency manifests only. Runtime state, calendars, exports, environment files and access credentials are ignored. The pre-publication scanner is an additional check, not a substitute for reviewing staged files.
- Local mode listens on loopback and checks the Host header and write-request Origin. Its default trust boundary is the signed-in operating-system account; other local processes or users with filesystem access can access local files. Use full-disk encryption and normal account security for the device.
- Cloud mode requires a private Blob token and a SHA-256 hash of a randomly generated 256-bit access key. It fails closed when configuration is missing. Vercel Authentication on **all deployments**, including production, provides an additional account-level boundary.
- The raw access key never enters client source or localStorage. Login uses constant-time hash comparison, persisted rate limits and opaque random session tokens. Stored sessions contain token hashes. Cookies are HttpOnly and SameSite=Strict; cloud cookies are Secure and host-scoped. Sessions expire after eight hours, and logout revokes them.
- APIs, app documents and downloads are marked `no-store`. There is no service worker caching private content. Read/write/export/calendar endpoints require authentication in cloud mode. State writes require matching revisions and storage ETags.
- Write requests require a matching Origin; cross-origin writes are rejected and responses do not opt into CORS. CSP restricts scripts to this origin. Inline styles support timeline positions; inline scripts are not allowed. Personal text is escaped in HTML and written as literal spreadsheet text.
- Calendar fetching accepts only direct HTTPS Google Calendar iCal URLs, disallows redirects, bounds size/time and does not return secret feed URLs to clients. Data is held by the selected storage provider; this is not end-to-end encryption.
- Preview and production use separate storage prefixes. Private Blob access tokens still have store-wide authority, so restrict who can manage deployment environments.

## Maintenance

Run `npm ci`, `npm test`, `npm run security:scan`, and `npm audit` when updating dependencies. Review Git's staged diff before pushing. Do not commit `.data`, `.env*` (except the documented blank example), `.secrets`, exported files, or real calendar feeds. Do not attach private data or tokens to public Issues.

To rotate the app key, securely retain any needed recovery material, move the old `.secrets` folder outside the checkout, run `npm run setup:key`, replace the server-only hash in Vercel, and redeploy. The app binds sessions to the configured key hash, so old sessions stop working after rotation. Revoke/rotate a leaked Blob token through Vercel; reset a leaked secret calendar URL in Google Calendar. Never assume deleting a file from the latest Git commit removes it from repository history.

No automated check proves the absence of every vulnerability. This app is intended for a personal workspace with limited access. Report security problems privately to the repository owner; public reports should contain only a minimal synthetic reproduction and no credentials or personal records.
