# Run storage contract v1

Every crawl is stored as one self-contained run directory:

```text
storage/
  runs/
    <runId>/
      input.json
      output.json
  key_value_stores/
    <runId>/
      ... actor checkpoints only
  logs/
    <runId>.log
```

`key_value_stores` is reserved for actor checkpoints and session state. It is
not an input or result store.

## Input

```json
{
  "schemaVersion": "1.0",
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

All items are appended to the `items` array in one atomic `output.json`:

```json
{
  "schemaVersion": "1.0",
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

Use `context.dataset.pushData(itemOrArray)` from an actor. The SDK serializes
updates per run and atomically replaces the output file, so readers never see a
partially written JSON document.

## API and CLI

- `GET /api/runs/:id/input` returns the versioned input document.
- `GET /api/runs/:id/output` returns the versioned output document.
- The dashboard **Data** action downloads that single output document.
- `omnicrawl run <actorPath> --input input.json` runs an actor with a JSON
  payload.
- `omnicrawl storage:migrate` consolidates legacy per-item dataset files. It
  verifies the resulting item count before removing the legacy dataset folder.

For very large datasets, a later storage adapter can keep this public contract
while moving `items` to object storage or a database. Actors should only use the
SDK and must not write result files directly.
