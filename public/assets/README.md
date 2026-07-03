# public/ — Folder Organization

## Structure

```
public/
├── assets/              ← shared static assets (CSS, JS, images, audio)
│   ├── payment/         ← payment-method logos (PromptPay, TrueMoney, etc.)
│   │   ├── FFP-logo.png
│   │   ├── icon-thaiqr.png
│   │   ├── QR-PromptPay.png
│   │   └── TrueWallate.png
│   ├── overlays/        ← overlay decorative assets
│   │   └── Overlay_pic.gif
│   ├── audio/           ← default audio assets
│   │   └── my-sound.mp3
│   ├── style.css        ← shared site styles (used across auth, donate, thank-you)
│   ├── tipkub-loading.css / tipkub-loading.js  ← shared loading screen
│   ├── cookie-consent.js  ← GDPR/consent banner
│   └── banner.jpg       ← OG/Twitter share image (/assets/banner.jpg)
│
├── dashboard/           ← authenticated streamer dashboard
│   ├── index.html
│   ├── dashboard.js
│   ├── admin.css
│   ├── sound-cache.js
│   └── dona-monitor.html
│
├── donate-template/     ← public donate page (readFileSync at startup — do NOT rename)
│   ├── index.html
│   ├── app.js
│   └── thank-you.html   ← post-donation thank-you page
│
├── goal-bar/            ← standalone goal-bar widget
│   ├── index.html
│   ├── goal-bar.css
│   ├── goal-bar.js
│   └── goal-bar-animation.js
│
├── overlay/             ← OBS browser-source overlay (all files co-located)
│   ├── index.html       ← overlay page (served by GET /overlay + GET /:username/overlay)
│   ├── overlay.css      ← overlay styles
│   └── overlay.js       ← SSE client + alert queue
│
├── pages/               ← HTML pages served via Express sendFile routes
│   ├── auth/            ← auth pages (5 files)
│   │   ├── login.html
│   │   ├── register.html
│   │   ├── register-setup.html
│   │   ├── login-failed.html
│   │   └── forbidden.html
│   ├── index.html       ← landing page (GET /)
│   ├── alert-test.html  ← dev/test alert (GET /alert-test)
│   ├── privacy.html     ← privacy policy (GET /privacy.html)
│   └── terms-of-services.html  ← terms (GET /terms-of-services.html)
│
├── avatar.jpg           ← DO NOT MOVE — hardcoded in server.js, database.js, dashboard.js,
│                          donate-template/app.js, register-setup.html, dashboard/index.html
│                          + absolute prod URL https://tipkub.me/avatar.jpg in server.js:2680
├── favicon.ico          ← site favicon
├── favicon.png          ← site favicon (PNG)
├── robots.txt
└── sitemap.xml
```

## Why avatar.jpg stays at root

`avatar.jpg` has 15+ references across backend AND frontend, including a hardcoded
absolute production URL `https://tipkub.me/avatar.jpg` in `server.js`. Moving it
requires updating `server.js`, `database.js`, `dashboard.js`, `donate-template/app.js`,
`donate-template/index.html`, `register-setup.html`, `dashboard/index.html` simultaneously.
High blast radius — kept at root by design.

## Assets folder conventions

| Subfolder | Contents | Reference pattern |
|-----------|----------|-------------------|
| `assets/payment/` | Payment logos | `/assets/payment/...` |
| `assets/overlays/` | Overlay GIFs | `/assets/overlays/...` |
| `assets/audio/` | Default audio | `/assets/audio/...` |
| `assets/*.css/js` | Shared UI components | `/assets/...` |
| `assets/banner.jpg` | OG/Social image | `/assets/banner.jpg` or `https://tipkub.me/assets/banner.jpg` |

When adding new payment providers or overlay assets, place them in the appropriate subfolder.
