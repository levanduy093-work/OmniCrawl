# OmniCrawl - Architecture Overview

OmniCrawl is designed as a distributed, actor-based platform for web crawling and browser automation. This document provides a high-level overview of how the components interact.

## High-level Architecture

OmniCrawl consists of several independent but interconnected systems:

```text
User / External System
        ↓
    Core API Server (REST/GraphQL)
        ↓
   Job Scheduler & Request Queue
        ↓
    Worker Nodes
        ↓
    Crawler Actors
```

## Main Components

### 1. Core API (`apps/api`)
The brain of OmniCrawl. It exposes REST/GraphQL APIs, manages the database state (Actors, Runs, Schedules), and communicates with the task queue.

### 2. Dashboard (`apps/dashboard`)
The web interface (built with React/Next.js) for users to monitor crawlers, manage configurations, view logs, and export datasets.

### 3. Worker Node (`apps/worker`)
A daemon process that pulls jobs from the Job Queue and executes them. It provisions isolated environments for **Actors** (crawlers) and reports status back to the Core.

### 4. CLI (`apps/cli`)
A command-line tool allowing developers to create, test, and deploy Actors easily without using the dashboard.

### 5. Actors (`actors/*`)
The actual crawler scripts. Each Actor is an independent application with its own input/output schema, running in a sandboxed environment on a Worker Node.

### 6. Shared Packages (`packages/*`)
- **`@omnicrawl/core`**: Core types and business logic.
- **`@omnicrawl/sdk`**: The library developers use to build Actors.
- **`@omnicrawl/database`**: Database schemas and migrations.
- **`@omnicrawl/utils`**: Shared utilities like logging and config parsing.

## Infrastructure Dependencies
In a production deployment, OmniCrawl relies on:
- **Database**: PostgreSQL (for metadata).
- **Queue/Cache**: Redis.
- **Storage**: Object Storage (S3-compatible) or Local File System for datasets.
