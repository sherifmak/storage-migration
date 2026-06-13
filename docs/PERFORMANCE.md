# CloudFerry — Data Transfer Performance Analysis

Investigation of the transfer pipeline for throughput/wall-clock optimization.
Scope: `src/engine.js`, `src/store.js`, `src/providers/*`, `src/util/http.js`,
`src/util/retry.js`. No runtime behaviour was changed by this document; it is
analysis + recommendations only.

Reference for the current design:

- Worker pool of fixed size `concurrency` (default 4), each worker pulls one
  whole item at a time from a pre-sorted queue (`engine._transfer`).
- Per file: **download fully to a staging file on disk, THEN upload** from that
  file (`engine._transferFile`). Staging file deleted only after upload commits.
- HTTP goes through the global `fetch()` (undici) with **no custom dispatcher /
  Agent / keep-alive tuning** (`util/http.js`).
- Resume state is journalled to an append-only `journal.jsonl`, throttled to
  ~once per 750 ms during transfer.

---

## Quick wins (high impact, low effort)

These are safe, localized, and do not change the resume/journal model.

1. **Configure a tuned undici `Agent` (keep-alive + connection pool) and set it
   as the global dispatcher.** Today every request uses undici defaults
   (`connections` effectively unbounded per origin but no explicit keep-alive
   timeout tuning, default pipelining). Each provider talks to only 2–3 origins
   (`content.dropboxapi.com`, `upload.box.com`, `googleapis.com`), so a properly
   sized, long-keep-alive pool eliminates repeated TLS handshakes on the hot
   upload/download/append path. **Impact: high. Effort: low.**

2. **Skip files already present at the destination (idempotent re-runs).**
   `STATUS.SKIPPED` exists in `store.js` but is never set anywhere — the
   skip-existing optimization is entirely unimplemented. On a re-run or a second
   pass, every already-migrated file is re-downloaded and re-uploaded. Add a
   destination "does this name+size (and hash if cheap) already exist?" check.
   **Impact: high on re-runs. Effort: low–med.**

3. **Raise the default concurrency and/or make it origin-aware.** Default of 4
   is conservative for a small number of remote origins with high
   bandwidth-delay product. With keep-alive + a streaming pipeline, 8–16 is
   typically better for many small/medium files. **Impact: med. Effort: trivial.**

4. **Increase stream `highWaterMark` for staging reads/writes.** Download write
   streams and upload `createReadStream` slices use the default 64 KiB
   highWaterMark, which means many tiny syscalls on multi-GB files. Bumping to
   1–4 MiB reduces syscall overhead and improves disk throughput.
   **Impact: low–med. Effort: low.**

5. **Compute Box's whole-file SHA-1 once, while streaming parts, instead of
   re-reading the whole file at commit.** See recommendation #7. **Impact: med
   for Box. Effort: low.**

---

## Detailed recommendations (ranked by impact ÷ effort)

### 1. HTTP layer: keep-alive connection pooling (undici Agent)

**Problem.** `util/http.js` calls the global `fetch()` with no `dispatcher`.
Undici's default global dispatcher is not tuned for this workload: connections
are not aggressively kept warm, and there is no explicit per-origin pool sizing.
Every upload chunk (`append_v2`, resumable `PUT`, Box part `PUT`), every RPC, and
every download attempt may pay TLS/connection setup. For a job that issues tens
of thousands of HTTPS requests to ~3 origins, the cumulative handshake +
slow-start cost is significant, especially across high-latency links.

**Proposed change.** Create one tuned `undici.Agent` and install it as the global
dispatcher at startup (e.g. in `util/http.js` module init):

```js
const { Agent, setGlobalDispatcher } = require('undici');
setGlobalDispatcher(new Agent({
  connections: 64,            // per-origin socket pool ceiling
  keepAliveTimeout: 60_000,   // keep sockets warm between chunks
  keepAliveMaxTimeout: 600_000,
  pipelining: 1,              // 1 is safest for large streamed bodies
  headersTimeout: 120_000,
  bodyTimeout: 0,             // long streaming uploads; rely on our own timeout
}));
```

`undici` is bundled with Node (it backs `fetch`), so this keeps the
"zero runtime dependencies" promise — `require('undici')` resolves to the
built-in. Verify on the supported floor (Node 18.17+); `require('undici')` is
available there.

**Caveat.** `bodyTimeout: 0` removes undici's own stall detection on long
uploads; the code already wraps requests in `combinedSignal` with a 120 s
`timeoutMs`, but that timeout currently fires for the *whole* request including a
multi-minute chunk upload — see recommendation #8 about per-request timeouts for
streamed bodies. Keep `headersTimeout` finite.

**Impact: high. Effort: low. Providers: all.**

---

### 2. Streaming / pipelined download→upload instead of stage-to-disk

**Problem (the big one).** `engine._transferFile` does a strict two-phase
sequence per file: download the *entire* file to `staging/<seq>.part`, `fs.stat`
it, then upload it. Consequences:

- **Wall-clock ≈ download_time + upload_time** for every file (serialized),
  instead of `max(download, upload)`. For a symmetric link this roughly *doubles*
  per-file latency.
- **Disk I/O:** every byte is written to disk and read back — 2× the file size in
  local I/O, plus the `fs.statSync` calls. On a fast network with a slow disk,
  the disk becomes the bottleneck.
- **Disk capacity:** as the README notes, you need `concurrency × largest file`
  of free space. This caps concurrency for large-file jobs.
- The worker is busy the whole time, so download and upload of *different* files
  do already overlap *across* workers — but within one file they never overlap.

**Two distinct improvements:**

**(a) Pipeline within a file (stream download → upload).** Pipe the source
download body directly into the destination upload, so a file uploads as it
downloads. `max(d,u)` instead of `d+u`, and no disk round-trip. This is the
single largest latency win for medium/large files.

*Difficulty: high*, because it interacts badly with the current resume model and
with several provider upload APIs:
  - Dropbox `upload_session` and Box parts and Google resumable all want
    **known chunk boundaries / sizes up front** or at least fixed-size chunks.
    Streaming works cleanly if you buffer one chunk at a time in memory
    (e.g. 16 MiB) and feed chunks to the uploader as they arrive — a bounded
    in-memory pipeline, not a full disk stage.
  - Resume granularity drops to "restart the file" unless you still persist the
    chunk offset (you can: keep the upload-session resume state, just don't keep
    the bytes on disk; on resume re-download from the committed upload offset
    using a `Range` request). This is doable but is the careful part.
  - Box's commit needs the whole-file SHA-1, which you can accumulate as bytes
    stream through (see #7), so streaming actually *helps* Box.

**(b) Pipeline across files per worker (prefetch next download).** Much lower
risk: keep stage-to-disk, but let a worker begin downloading the *next* file
while it uploads the current one (double-buffering). This overlaps the two
network directions without touching the resume model or provider chunking. Costs
one extra staging file per worker.

**Recommendation.** Ship (b) first (medium effort, low risk, big win on
asymmetric overlap), then evaluate (a) — a bounded-memory chunked pipeline — for
large files specifically. Keep stage-to-disk as the fallback for resume
robustness.

**Impact: high. Effort: (b) med / (a) high. Providers: all, with per-provider
chunk-boundary care for (a).**

---

### 3. Skip work already done at the destination

**Problem.** `STATUS.SKIPPED` is defined but never assigned. There is no
"already exists at destination" check, so:
  - a `resume` that re-discovers, or a re-run against a partially-migrated
    destination, re-transfers everything;
  - discovery already captures `srcHash` (Dropbox `content_hash`, Box `sha1`) and
    `size`, which is exactly the data needed to skip.

**Proposed change.** Before transferring a file, check the destination container
for an item with the same name and matching size (and hash where the destination
exposes one cheaply: Dropbox `content_hash`, Drive `md5Checksum`, Box `sha1`). If
it matches, mark `STATUS.SKIPPED` and move on. Cache a per-folder listing of the
destination (one list call per folder, reused across that folder's files) so this
is one extra API call per *folder*, not per file.

Note hashing mismatches across providers: source hash algorithm rarely matches
the destination's, so cross-provider hash comparison usually isn't possible —
fall back to name+size, which is the realistic idempotency key here. Same-format
verification (size end-to-end) is already done post-transfer.

**Impact: high on re-runs / incremental syncs. Effort: low–med. Providers: all,
listing-API specific.**

---

### 4. Parallelize discovery with transfer

**Problem.** `engine.run()` runs `_discover()` fully to completion before
`_transfer()` starts (README "Discovery first"). For a large tree this is dead
time where no bytes move — discovery can take minutes on hundreds of thousands of
items. The design choice is deliberate (keeps resume simple, fixes the work set),
but it costs wall-clock at the front of every fresh job.

**Proposed change.** Allow transfer workers to start draining the queue as items
are appended to the manifest, rather than waiting for `finishDiscovery()`. The
manifest is already append-only and seq-ordered, so workers can consume a growing
queue. Keep the "discovery complete" flag for resume correctness; the engine just
doesn't *block* on it.

**Caveat.** This complicates the "folders first" ordering (currently a full sort
of the snapshot) — you'd need to ensure a file's parent folder is created before
the file, e.g. by `ensureContainer(dirOf(path))` on demand (which the upload path
already does via `ensureContainer` with its in-flight cache). The folder-first
sort in `_transfer` becomes unnecessary if `ensureContainer` is always called
per file (it already is, line 191). Risk is mostly around resume semantics if
interrupted mid-discovery (the code already calls `resetItems()` in that case).

**Impact: med (front-loaded wall-clock). Effort: med. Providers: all.**

---

### 5. Per-file granularity vs. parallel chunks for very large files

**Problem.** The unit of parallelism is one whole file per worker. When a job is
**a few huge files** (e.g. 4 workers, 4 × 50 GB files), you get exactly 4 streams
and cannot use more bandwidth even if `concurrency` is raised, because there are
only 4 items. Conversely many tiny files under-utilize per-connection throughput.

**Proposed change — parallel chunk transfer for large files, provider-permitting:**

  - **Box: YES.** Box chunked upload sessions allow parts to be uploaded **in
    parallel** (each `PUT .../upload_sessions/{id}` with its own `content-range`).
    The current `_uploadChunked` loop is strictly sequential. Uploading N parts
    concurrently (with a small per-file part-concurrency, e.g. 3–4) is a large
    win for single huge files. Resume already re-lists parts, so it composes well.
    Likewise the **download** side could issue parallel `Range` GETs against the
    pre-signed CDN URL Box returns.
  - **Dropbox: NO for a single session.** `upload_session/append_v2` appends are
    sequential by offset; you cannot parallelize appends within one session. (You
    *can* parallelize the *download* with multiple `Range` requests.) So for
    Dropbox, large-file speedup must come from parallel-range download +
    sequential chunked upload pipelined together (#2a).
  - **Google Drive: NO.** Resumable upload is strictly sequential by
    `Content-Range`; one ordered stream. Download can be parallel-ranged.

**Recommendation.** Add an optional "large file" path: when `size` exceeds a
threshold and the provider permits, split into parallel range-downloads and (Box
only) parallel part-uploads, sharing the worker's concurrency budget. This is the
key lever for *few huge files* jobs.

**Impact: high for few-huge-files workloads, low otherwise. Effort: med–high.
Providers: Box (up+down), Dropbox/Drive (down only).**

---

### 6. Adaptive concurrency & backpressure on 429s

**Problem.** `concurrency` is fixed for the whole run. `withRetry` honours
`Retry-After` per request, but a sustained 429 storm just means every worker
backs off independently and repeatedly — there is no global signal to *reduce*
the number of in-flight transfers, nor to *increase* it when the link is idle.
Chunk sizes (`CHUNK = 16 MiB` Dropbox/Drive, Box server-chosen) are also fixed.

**Proposed change.** A lightweight adaptive controller:
  - Track a moving average of throughput (the engine already samples `rate`).
  - On 429 / `Retry-After` observed by any worker, decrement an effective
    concurrency cap (AIMD: multiplicative decrease); on a clean window, slowly
    increase it back up to the configured max (additive increase).
  - Optionally adapt chunk size to observed per-chunk latency (bigger chunks on
    fast, stable links reduce per-request overhead; smaller on flaky links
    improve resume granularity).

Implement as a shared semaphore the workers acquire before each transfer, whose
permit count the controller adjusts. Keeps the worker loop simple.

**Caveat.** Don't let adaptation fight the existing per-request backoff; the
controller should react to *rate-limit frequency*, not individual transient 5xx.

**Impact: med (protects throughput under throttling; avoids manual tuning).
Effort: med. Providers: all (429 semantics are uniform).**

---

### 7. Box checksum: compute SHA-1 once, not twice (and not from disk)

**Problem.** In `box.js _uploadChunked`:
  - each part is read into memory and SHA-1'd for the per-part `digest`
    (`sha1Base64(buf)`), and then
  - the **whole file is read again** end-to-end to compute `sha1FileBase64` for
    the commit `digest` (line 238, `sha1FileBase64(localPath)`).

So Box reads the file from disk roughly twice for hashing alone, on top of the
read for the actual upload body. For large files this is real CPU + disk cost.

**Proposed change.** Maintain a single running `crypto.createHash('sha1')` and
`.update()` it with each part buffer *as the parts are read for upload*, then
`.digest('base64')` at commit time. One pass, no second full read. (Requires
parts to be hashed in order; if #5's parallel part upload is adopted, accumulate
the whole-file hash from a separate ordered read or from the download stream
instead.)

Even better, combined with the streaming pipeline (#2a): compute the SHA-1 while
the bytes stream through from the download, so the whole-file hash is free.

**Impact: med for Box large files. Effort: low (sequential) / med (with parallel
parts). Providers: Box.**

---

### 8. Per-request timeout vs. long streamed bodies

**Problem.** `util/http.js` applies a single `timeoutMs` (default 120 s) that
arms a timer at request start and aborts the whole request. For a streamed chunk
upload/download that legitimately takes longer than 120 s on a slow link, this
fires mid-transfer and forces a retry (wasted bytes). It is a correctness/perf
hazard, not just cosmetic, on slow connections with 16 MiB chunks.

**Proposed change.** For streaming bodies, replace the fixed total timeout with a
**stall timeout**: reset the timer on each progress chunk (no bytes for N seconds
= abort), rather than a hard ceiling on total duration. The progress callbacks in
`pipeBody` and the upload loops already fire per chunk and can feed this.

**Impact: med on slow/large transfers. Effort: low–med. Providers: all.**

---

### 9. Memory: avoid `fs.readFileSync` of whole files for small uploads

**Problem.**
  - `box.js _uploadSimple` does `fs.readFileSync(localPath)` then wraps it in a
    `Blob` (whole file in memory).
  - `gdrive.js _uploadMultipart` does `Buffer.concat([head, fs.readFileSync(...),
    tail])` (whole file in memory, plus a copy).
  - Box `readSlice` buffers each part fully in memory too.

With high concurrency on many "small" files (Box simple < 20 MiB, Drive multipart
< 8 MiB), peak memory ≈ `concurrency × file_size × (1–2 copies)`. At concurrency
16 and 8–20 MiB files that's hundreds of MB to ~1 GB of transient buffers, plus
GC pressure that hurts throughput.

**Proposed change.** Stream these small uploads from disk instead of buffering:
  - Drive multipart: build the multipart body as a stream
    (head stream + file `createReadStream` + tail stream) rather than
    `Buffer.concat`. Or use a single resumable PUT for everything and drop the
    multipart path.
  - Box simple upload: stream the file part of the `FormData` from disk
    (avoid `readFileSync`). If `FormData`/`Blob` can't stream a file easily, lower
    the simple threshold so fewer files hit the buffering path.

This pairs naturally with the no-disk streaming pipeline (#2): for small files,
skip the disk round-trip entirely and stream source→dest directly in memory
(bounded by file size).

**Impact: med at high concurrency / many small files. Effort: med. Providers:
Box, Google Drive.**

---

### 10. Small-file overhead & journal write amplification

**Problem.** Per small file the pipeline still does: create staging file, write,
stat, ensureContainer, upload, unlink, plus journal writes. For hundreds of
thousands of tiny files the per-item fixed overhead dominates over actual bytes.
Also `store.update` writes a journal line on every status change; `_compactJournal`
rewrites the whole journal when it grows — fine, but the 750 ms throttled
`persist` during transfer is mostly irrelevant for sub-second small files (good)
while folder/done updates are unbatched.

**Proposed change.**
  - For small files, skip disk staging entirely (stream/buffer in memory, #9/#2).
  - Batch journal `DONE` writes (e.g. flush a group of completions in one
    `write`) to cut fs write syscalls when churning through tiny files. The
    append-only crash-safety model is preserved (still append-only, just coarser).
  - Consider reusing one destination folder listing for skip-checks (#3) so small
    files in a folder share one list call.

**Impact: med for huge-count small-file jobs. Effort: med. Providers: all.**

---

## Summary table

| # | Recommendation | Impact | Effort | Providers |
|---|----------------|--------|--------|-----------|
| 1 | undici Agent keep-alive / pool | High | Low | all |
| 3 | Skip files already at destination (use unused `SKIPPED`) | High (re-runs) | Low–Med | all |
| 2b | Prefetch next download while uploading (cross-file pipeline) | High | Med | all |
| 5 | Parallel chunks for huge files | High (few-huge) | Med–High | Box up+down; DBX/Drive down |
| 7 | Box SHA-1 once, streamed | Med | Low | Box |
| 2a | True streaming download→upload (no disk stage) | High | High | all |
| 8 | Stall timeout instead of total timeout | Med | Low–Med | all |
| 6 | Adaptive concurrency on 429 (AIMD) | Med | Med | all |
| 9 | Stream small uploads (no `readFileSync`) | Med | Med | Box, Drive |
| 4 | Overlap discovery with transfer | Med | Med | all |
| 10 | Small-file staging skip + journal batching | Med | Med | all |
| QW | Raise default concurrency (4→8–16) | Med | Trivial | all |
| QW | Larger stream `highWaterMark` (1–4 MiB) | Low–Med | Low | all |

## Provider constraint cheat-sheet (parallelism within one file)

| Provider | Parallel upload chunks? | Parallel range download? | Resumable upload model |
|----------|-------------------------|--------------------------|------------------------|
| Dropbox  | **No** (`append_v2` sequential by offset within a session) | Yes (`Range`) | `upload_session` + `incorrect_offset` correction |
| Google Drive | **No** (resumable PUT strictly sequential by Content-Range) | Yes (`Range`) | resumable session, re-query `308` offset |
| Box | **Yes** (parts may be PUT in parallel) | Yes (pre-signed CDN URL, `Range`) | chunked session, re-list parts, SHA-1 verified |

## Suggested sequencing

1. Quick wins: Agent/keep-alive (#1), default concurrency, highWaterMark.
2. Skip-existing (#3) and Box single-pass SHA-1 (#7) — isolated, high value.
3. Cross-file prefetch pipeline (#2b) and stall timeout (#8).
4. Parallel chunks for huge files (#5) and adaptive concurrency (#6).
5. True streaming pipeline (#2a) + small-file memory streaming (#9/#10), the
   most invasive, behind the safety net of stage-to-disk resume.

All recommendations preserve the append-only, crash-safe resume guarantee; the
invasive ones (#2a, #5) require explicitly keeping the upload-session resume
state while dropping the on-disk bytes, and re-downloading from offset on resume.
