# Getting Started with OmniCrawl Development

This guide will help you set up the development environment for OmniCrawl.

## Prerequisites

- **Node.js**: >= 20.0.0
- **pnpm**: >= 9.0.0 (We use pnpm workspaces)
- **Docker & Docker Compose** (Optional, but recommended for running DB/Redis locally)

## Installation

1. **Clone the repository:**
   ```bash
   git clone <repository_url>
   cd OmniCrawl
   ```

2. **Install dependencies:**
   Run pnpm install from the root directory to install all dependencies across the monorepo.
   ```bash
   pnpm install
   ```

## Workspace Structure

This is a Monorepo managed by `pnpm`.

- `apps/*`: Runnable applications (API, Dashboard, CLI, Worker).
- `packages/*`: Shared internal libraries.
- `actors/*`: Example crawlers and templates.

## Running the Project Locally

*(Note: Specific start commands will be updated as the apps are implemented)*

To build all packages:
```bash
pnpm build
```

To run development servers for all apps:
```bash
pnpm dev
```

## Creating a new Actor

You can create a new Actor by copying the TypeScript template:
```bash
cp -r actors/template-ts actors/my-new-scraper
```
