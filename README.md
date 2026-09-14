# OmniCrawl

<p align="center">
  <a href="https://ko-fi.com/levanduy093_work">
    <img src="https://img.shields.io/badge/Ko--fi-Support%20Project-F16061?style=for-the-badge&logo=ko-fi&logoColor=white" alt="Support on Ko-fi" />
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="License: MIT" />
  </a>
</p>

<p align="center">
  <b>English</b> | <a href="README.vi.md">Tiếng Việt</a>
</p>

---

OmniCrawl is an actor-based e-commerce web scraping platform designed to run locally, giving users full control over their browser sessions. The repository features two independent runtimes:

- **Web + Browser Agent:** A React dashboard to create and monitor runs, a REST API persisting data into PostgreSQL, and a Chrome/Edge Extension executing actors within your logged-in browser session.
- **Desktop:** An experimental standalone Electron application running independently without the API or PostgreSQL, utilizing an embedded browser and local SQLite storage. (Currently supports Shopee Search).

> [!NOTE]
> Successful compilation confirms the code builds. Real-world scraping depends on active sessions, platform interfaces/APIs, Incognito permissions, proxies (if enabled), and CAPTCHA/traffic challenges.

---

## Features

- **Role-Based Access Control:** Manage accounts with `USER`, `ADMIN`, and `SUPER_ADMIN` roles.
- **Run Management:** Create, pause, stop, delete, track real-time progress, and inspect execution logs.
- **Dataset Exploration:** Paginated dataset view, filtering, and data export.
- **Privacy & Security:** The Browser Agent keeps session cookies local in Chrome/Edge; cookies are never sent to the backend API.
- **Proxy Support:** Optional proxy pool management with credential encryption and pre-flight connectivity checks.
- **Bilingual Interface:** Both Dashboard and Desktop runtimes support Vietnamese and English.
- **Offline Desktop Mode:** Desktop app saves collected data into SQLite and exports directly to CSV/JSONL.

---

## Available Actors

| Actor | Runtime | Primary Inputs | Output Data |
| --- | --- | --- | --- |
| `shopee-scraper` | Browser Agent & Desktop | Keyword, filters, item limit | Product listings; Browser Agent can scrape deep details |
| `shopee-shop-scraper` | Browser Agent | Shopee shop URL | Shop products retrieved via shop pagination |
| `tiktok-scraper` | Browser Agent | Keyword, video mode or TikTok Shop | Videos or TikTok Shop products |

> Shopee Search and Shopee Shop are distinct actors with separate input schemas and lifecycles. Desktop currently registers `shopee-scraper` only; it is not a complete drop-in replacement for the Browser Agent.

---

## Architecture

### Web + Browser Agent Flow

```text
Dashboard -> REST API -> PostgreSQL
    ^            ^            |
    |            |            v
    +------ Chrome/Edge Browser Agent
```

1. The Dashboard submits actor inputs to the REST API.
2. The API validates schema, persists inputs, and enqueues the run with `BROWSER_PENDING` status.
3. The Chrome/Edge Extension polls for jobs and runs the actor within your active logged-in browser tab.
4. The extension streams collected items, logs, and status back to the API; Dashboard visualizes live results.
5. If CAPTCHA or traffic challenges arise, the run pauses for human intervention.

### Desktop Flow

```text
React renderer -> Validated IPC -> Electron main process
                                     ├── Dedicated browser manager & profile
                                     ├── Actor runtime
                                     └── SQLite + CSV/JSONL export
```

See [docs/architecture.md](docs/architecture.md) for deeper architectural details.

---

## Repository Structure

```text
apps/
├── api/                 REST API, authentication, run queues, dataset & proxy management
├── browser-extension/   Chrome/Edge Browser Agent and actor runtimes
├── dashboard/           React 19 + Vite dashboard UI
└── desktop/             Electron desktop application with embedded browser & local SQLite
packages/
├── database/            Prisma schema, PostgreSQL client, migrations and seeds
└── sdk/                 Shared data contracts, types, and storage utilities
docs/
└── architecture.md      Web + Browser Agent architecture documentation
```

`node_modules/`, `dist/`, `coverage/`, TypeScript build caches, and `storage/` are generated artifacts and are git-ignored.

---

## Prerequisites

- **Node.js 20+**
- **pnpm 9+**
- **Docker** (Recommended for local PostgreSQL)
- **Google Chrome** or **Microsoft Edge** (Required for Browser Agent)
- **PostgreSQL 15** with `vector` and `pg_trgm` extensions (if not using provided Docker Compose)

---

## Getting Started (Web + Browser Agent)

### 1. Configure Environment

```bash
cp .env.example .env
```

Ensure `POSTGRES_PASSWORD` and the password inside `DATABASE_URL` match.

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection string for Prisma/API |
| `POSTGRES_USER` | With Docker | PostgreSQL username |
| `POSTGRES_PASSWORD` | With Docker | PostgreSQL password |
| `POSTGRES_DB` | With Docker | Database name |
| `HOST` | No | API binding host, defaults to `127.0.0.1` |
| `PORT` | No | API port, defaults to `3001` |
| `JWT_SECRET` | No | Auto-generated in local `storage/` if left blank |
| `ADMIN_EMAIL` | No | Initial admin email created during seed |
| `ADMIN_PASSWORD` | For seeding | Admin password (min. 12 characters) |

> [!WARNING]
> Never commit `.env` or local keys/logs located in `storage/`.

### 2. Start Database & Install Dependencies

```bash
docker compose -f docker-compose.example.yml up -d db
pnpm install
pnpm db:push
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='replace-with-a-strong-password' pnpm db:seed
```

`db:push` synchronizes Prisma schema. `db:seed` registers default actors and creates the initial admin user.

### 3. Run API and Dashboard

```bash
pnpm dev
```

- **Dashboard:** <http://localhost:5173>
- **API:** <http://localhost:3001>

### 4. Install Browser Agent (Extension)

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode** in the top right corner.
3. Click **Load unpacked** and select the `apps/browser-extension` folder.
4. In extension details, enable **Allow in Incognito** (required for detailed Shopee scraping).
5. Open your target platforms (Shopee / TikTok) to log in, then open Dashboard.

> See [Browser Agent Guide](apps/browser-extension/README.md) for proxy rules and details.

---

## Desktop Application

The standalone Desktop application requires no PostgreSQL or backend API:

```bash
pnpm install
pnpm --filter @omnicrawl/desktop rebuild:native
pnpm desktop:build
pnpm desktop:start
```

For development mode:

```bash
pnpm desktop:dev
```

Data is stored locally in the OS `userData/runtime` path. See [Desktop Guide](apps/desktop/README.md).

---

## Development Scripts

| Command | Description |
| --- | --- |
| `pnpm dev` | Build shared packages and launch API + Dashboard |
| `pnpm build` | Compile database, SDK, API, and Dashboard |
| `pnpm lint` | Run Oxlint on Dashboard codebase |
| `pnpm db:push` | Sync Prisma schema directly with PostgreSQL |
| `pnpm db:seed` | Seed default actors and initial admin account |
| `pnpm desktop:dev` | Launch Electron + Vite in live dev mode |
| `pnpm desktop:build` | Build Electron main process and renderer |
| `pnpm desktop:start` | Run Desktop app from compiled output |
| `pnpm check` | Run linter, build verification, desktop typecheck, and proxy security tests |

Run verification before committing:

```bash
pnpm lint
pnpm build
pnpm --filter @omnicrawl/desktop typecheck
pnpm desktop:build
pnpm --filter @omnicrawl/api test:proxy-security
```

---

## Troubleshooting

- **Dashboard cannot connect to API:** Ensure API is running at `127.0.0.1:3001` and port is not blocked.
- **No actors listed in Dashboard:** Run `pnpm db:seed` and re-login to Dashboard.
- **Browser Agent shows Offline:** Reload extension in `chrome://extensions`, refresh Dashboard, and verify permission to access `localhost:3001`.
- **Cannot scrape Shopee item details:** Ensure **Allow in Incognito** is enabled for the extension.
- **Desktop `better-sqlite3` ABI mismatch:** Run `pnpm --filter @omnicrawl/desktop rebuild:native`.
- **Proxy enabled but run blocked:** Check proxy connectivity in Proxy Manager; OmniCrawl intentionally does not fallback to direct IP to preserve privacy.

---

## ☕ Support the Project

OmniCrawl is an open-source project developed and maintained in free time. If you find OmniCrawl useful for your work or research, consider buying me a coffee to support continued development:

<p align="center">
  <a href="https://ko-fi.com/levanduy093_work" target="_blank">
    <img src="https://storage.ko-fi.com/cdn/kofi3.png?v=3" height="48" alt="Buy Me a Coffee at ko-fi.com" />
  </a>
</p>

---

## License

Released under the [MIT License](LICENSE).

For contributions, please refer to [CONTRIBUTING.md](CONTRIBUTING.md). For security vulnerabilities, report according to [SECURITY.md](SECURITY.md).
