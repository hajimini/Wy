# Wy

A lightweight blog frontend (`index.html`) and Cloudflare Worker backend (`worker.js`). The worker provides authentication, article CRUD APIs backed by D1, and optional GitHub-backed file uploads.

## Quick start
1. Deploy `worker.js` to Cloudflare Workers with a bound D1 database. Tables are auto-created on first use, but binding the database is required for article storage.
2. Set environment variables:
   - `ACCESS_PASSWORD`: site password (defaults to `741520` if unset, but you should override).
   - `GITHUB_TOKEN` and `GITHUB_REPO` (owner/repo) to enable uploads; omit to disable.
3. Host `index.html` on any static host (e.g., Cloudflare Pages). If the Worker is on a different origin, append `?api_base=https://your-worker.example.workers.dev` to the page URL once—the value is persisted in `localStorage`.

## Notes
- Sessions expire after 10 minutes; the frontend renews the timer on each auth check. When D1 is not bound, the Worker falls back to in-memory sessions only (best-effort, clears on instance restart).
- File uploads use FormData; large files are uploaded via the Worker to GitHub when configured, small images inline as data URLs.
- Links rendered from markdown open in a new tab with `rel="noopener noreferrer"` for safety.

## Manual deployment
If you want to push this code to your own GitHub repo, add a remote and push:
```bash
git remote add origin git@github.com:<your_account>/<repo>.git
git push -u origin work
```
Then connect the repo to Cloudflare Pages/Workers as needed.
