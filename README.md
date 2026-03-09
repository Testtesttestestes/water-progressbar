<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/b5900ef9-5bf6-4f38-b1c9-60272d50b2e5

## Run Locally

**Prerequisites:** Node.js

1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Build to a browser-openable static page

1. Build production files:
   `npm run build`
2. Start a local static server from `dist` (Python script):
   `npm run serve:dist`
3. Open in browser:
   [http://localhost:4173](http://localhost:4173)

## GitHub Actions workflow

Added workflow: `.github/workflows/build-static-page.yml`

It runs on push / pull request / manual dispatch and does:
- `npm ci`
- `npm run lint`
- `npm run build`
- packages `dist` together with `serve_dist.py` and uploads them as artifact `static-page`.
