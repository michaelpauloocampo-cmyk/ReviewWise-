REVIEWWISE 2.0 — UPGRADED PROJECT

WHAT'S INCLUDED
- Existing ReviewWise text, image, video, and document workflows retained.
- Responsive existing interface plus an optional persistent dark-mode toggle.
- Clear notice explaining that wording-pattern analysis is NOT a factual verdict.
- Local development uses the same-origin backend automatically.
- Backend security headers, configurable CORS allowlist, basic in-memory analysis rate limiting, /health and /capabilities endpoints.
- package.json added based on dependencies imported by the supplied server.js. Review dependency versions against your deployment environment before production use.

RUN LOCALLY
1. Install Node.js 18 or newer.
2. Open this folder in a terminal.
3. Run: npm install
4. Run: npm start
5. Open http://localhost:3000

OPTIONAL CONFIGURATION
- ALLOWED_ORIGINS: comma-separated exact origins allowed to call the API. If unset, browser CORS requests from other origins are not allowed.
- API_RATE_LIMIT: maximum /analyze requests per IP per minute (default 40). This in-memory limiter is for basic protection only; use a shared rate-limit store for multi-instance deployments.
- GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_CREDENTIALS_JSON: configure Google Cloud Vision on your hosting provider. NEVER commit credential files or paste secret JSON/API keys into public repositories or chat.
- REVIEWWISE_API_BASE: set a full backend URL only when frontend and backend are hosted separately.

IMPORTANT LIMITATIONS
- The current analyzer detects selected language patterns; it does not search the web, authenticate sources, or prove whether statements are true.
- Live fact-checking, source citations, user accounts, cloud-synced history, and a database are not implemented in this package.
- OCR depends on valid Google Cloud Vision credentials. Video OCR also depends on FFmpeg being available.
- The in-memory rate limiter resets when the server restarts and is not shared between server instances.
- Uploaded files should be reviewed for retention/cleanup requirements before public deployment.

BRANDING
The source refers to logo.png and favicon.png. Those image assets were not present in the provided project files. Add your own logo.png/favicon.png to this folder if you want the existing image references to display.
