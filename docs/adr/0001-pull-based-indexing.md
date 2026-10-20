# ADR-0001 — Pull-based indexing; WebSocket as a trigger only

- **Status:** Accepted
- **Date:** 2026-10-21

## Context
The indexer must survive WebSocket drops, RPC errors, restarts, and reorgs with zero gaps and zero duplicates. Event subscriptions (`eth_subscribe("logs")`) deliver data only while connected.

## Decision
All event data is fetched with `eth_getLogs` over HTTP for explicit ranges starting at the DB checkpoint + 1. The WebSocket `newHeads` feed only wakes the loop early. An always-on HTTP polling timer guarantees progress without it. Progress and data are committed in one transaction, and a Postgres advisory lock enforces a single writer.

## Alternatives considered
- **Log subscription + backfill on reconnect:** two code paths (live and backfill), overlap and dedup handling, and silent socket stalls are hard to detect.
- **Poll-only:** simplest, but adds up to one poll interval of latency. It's kept as the fallback mode anyway.

## Consequences
- One ingestion code path, so it's easy to test with chaos tests.
- Latency stays roughly one block when WS is healthy.
- More `getLogs` calls than a pure subscription. That's acceptable for a single token.
