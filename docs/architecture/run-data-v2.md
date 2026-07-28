# Run data contract v2

PostgreSQL is the source of truth for crawl input and output:

```text
Run
  input JSONB
  outputMetadata JSONB
  outputError
  itemCount
  DatasetItem[]

DatasetItem
  runId
  position
  data JSONB
```

The filesystem is reserved for temporary crawler checkpoints and text logs. It
is not an input or result store.

## Input

The API presents the database record using this stable document:

```json
{
  "schemaVersion": "2.0",
  "kind": "omnicrawl/run-input",
  "runId": "run-id",
  "actor": {
    "id": "actor-id",
    "name": "example-scraper",
    "version": "1.0.0"
  },
  "createdAt": "2026-07-28T15:00:00.000Z",
  "payload": {
    "startUrl": "https://example.com"
  }
}
```

Actors define `inputSchema` and `outputSchema` in `actor.json`. The dashboard
renders the input form from `inputSchema`, and the API validates and applies
defaults before persisting the run input.

## Output

Items are inserted in batches into `DatasetItem`. The API can present or export
them as one logical output:

```json
{
  "schemaVersion": "2.0",
  "kind": "omnicrawl/run-output",
  "runId": "run-id",
  "actor": {
    "id": "actor-id",
    "name": "example-scraper",
    "version": "1.0.0"
  },
  "status": "SUCCESS",
  "createdAt": "2026-07-28T15:00:01.000Z",
  "updatedAt": "2026-07-28T15:00:03.000Z",
  "completedAt": "2026-07-28T15:00:03.000Z",
  "stats": {
    "itemCount": 1
  },
  "metadata": {
    "source": "example.com"
  },
  "items": [
    {
      "url": "https://example.com",
      "title": "Example Domain"
    }
  ],
  "error": null
}
```

Use `context.dataset.pushData(itemOrArray)` from an actor. The SDK uses a
serializable database transaction to allocate stable item positions and update
the run item count.

## API and CLI

- `GET /api/runs/:id/input` returns the versioned input document.
- `GET /api/runs/:id/items` returns a paginated, human-readable dataset.
- `GET /api/runs/:id/output` returns the complete compatibility document.
- `GET /api/runs/:id/export?format=json|csv` downloads the dataset.
- The dashboard run detail displays input, metadata and a data table.
- `omnicrawl run <actorPath> --input input.json` runs an actor with a JSON
  payload.
- `omnicrawl storage:migrate` imports legacy file data into PostgreSQL. It
  verifies the database item count before removing the legacy files.

Actors should only use the SDK and must not write result files directly.
