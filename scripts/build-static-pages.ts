import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { filterExpiredEvents, normalizeEvents, normalizeMessages, normalizeSeries } from "../src/normalize";
import { ChurchCenterClient } from "../src/planning-center";
import type {
  AnyDraft,
  AnyRecord,
  Artwork,
  Env,
  EventRecord,
  FeedStatus,
  JsonApiDocument,
  StreamEnvelope,
  StreamName,
} from "../src/types";
import { canonicalArtworkSeed, errorMessage, sha256 } from "../src/util";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SERVICE_DIR = resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT = resolve(SERVICE_DIR, "dist-pages");
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const ALLOWED_IMAGE_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/avif", "avif"],
]);

interface StaticBuildConfig {
  outputDirectory: string;
  publicBaseUrl: URL;
  previousBaseUrl: URL;
  staleAfterSeconds: number;
  healthMaximumAgeSeconds: number;
  channelId: string;
  userAgent: string;
}

interface StaticPayload {
  schemaVersion: 1;
  generatedAt: string;
  baseUrl: string;
  streams: {
    events: StreamEnvelope<PublishedRecord<EventRecord>>;
    messages: StreamEnvelope<PublishedRecord<AnyRecord>>;
    series: StreamEnvelope<PublishedRecord<AnyRecord>>;
  };
}

type PublishedArtwork = Omit<Artwork, "sourceUrl" | "sourceExpiresAt">;
type PublishedRecord<T extends AnyRecord> = T extends unknown
  ? Omit<T, "image"> & { image: PublishedArtwork | null }
  : never;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizedBaseUrl(value: string | undefined, label: string): URL {
  if (!value) throw new Error(`${label} is required and must be the final HTTPS GitHub Pages base URL`);
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} must be a plain HTTPS URL`);
  }
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed;
}

function buildConfig(): StaticBuildConfig {
  const outputDirectory = resolve(process.env.STATIC_FEED_OUTPUT || DEFAULT_OUTPUT);
  const publicBaseUrl = normalizedBaseUrl(process.env.PUBLIC_BASE_URL, "PUBLIC_BASE_URL");
  const previousBaseUrl = normalizedBaseUrl(
    process.env.PREVIOUS_BASE_URL || publicBaseUrl.toString(),
    "PREVIOUS_BASE_URL",
  );
  return {
    outputDirectory,
    publicBaseUrl,
    previousBaseUrl,
    staleAfterSeconds: positiveInteger(process.env.STALE_AFTER_SECONDS, 7_200),
    healthMaximumAgeSeconds: positiveInteger(process.env.HEALTH_MAX_STALE_SECONDS, 86_400),
    channelId: process.env.CHANNEL_ID || "25787",
    userAgent: process.env.CC_USER_AGENT || "GNCO static feed (https://goodnewsco.church)",
  };
}

function assertSafeOutputDirectory(outputDirectory: string): void {
  const serviceRelative = relative(SERVICE_DIR, outputDirectory);
  if (!isAbsolute(outputDirectory) || !serviceRelative || serviceRelative === "." || serviceRelative.startsWith("..")) {
    throw new Error("STATIC_FEED_OUTPUT must be a child directory of migration/feed-service");
  }
}

function outputPath(config: StaticBuildConfig, relativePath: string): string {
  const resolved = resolve(config.outputDirectory, relativePath);
  const child = relative(config.outputDirectory, resolved);
  if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error("Unsafe output path");
  return resolved;
}

function publicUrl(config: StaticBuildConfig, relativePath: string): string {
  return new URL(relativePath.replace(/^\/+/, ""), config.publicBaseUrl).toString();
}

async function writeText(config: StaticBuildConfig, relativePath: string, content: string): Promise<void> {
  const destination = outputPath(config, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content, "utf8");
}

async function writeJson(config: StaticBuildConfig, relativePath: string, value: unknown): Promise<void> {
  await writeText(config, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function timedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("Static feed request timed out"), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function safeSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 100);
  return sanitized || "record";
}

function sourceImageAllowed(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      (host === "images.planningcenterusercontent.com" || host === "img.youtube.com" || /(^|\.)ytimg\.com$/.test(host))
    );
  } catch {
    return false;
  }
}

function withinPreviousBase(rawUrl: string, base: URL): boolean {
  try {
    const url = new URL(rawUrl);
    return url.origin === base.origin && url.pathname.startsWith(base.pathname);
  } catch {
    return false;
  }
}

async function fetchImage(rawUrl: string): Promise<{ bytes: Uint8Array; extension: string }> {
  const response = await timedFetch(rawUrl, {
    headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif" },
    // The source endpoints used by GNCO currently serve the binary directly. Refuse
    // redirects so an upstream image URL cannot turn this runner into an SSRF hop.
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Artwork source returned ${response.status}`);
  const contentType = (response.headers.get("Content-Type") || "").split(";", 1)[0]?.trim().toLowerCase() || "";
  const extension = ALLOWED_IMAGE_TYPES.get(contentType);
  if (!extension) throw new Error(`Unsupported artwork content type: ${contentType || "missing"}`);
  const declared = Number.parseInt(response.headers.get("Content-Length") || "", 10);
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) throw new Error("Artwork exceeds size limit");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Artwork exceeds size limit");
  return { bytes, extension };
}

async function imageFingerprint(draft: AnyDraft): Promise<string | null> {
  const source = draft.sourceArtwork;
  if (!source) return null;
  const seed = source.fingerprintSeed || canonicalArtworkSeed(source.url);
  return (await sha256(`${source.field}:${seed}`)).slice(0, 32);
}

function priorRecord(previous: StreamEnvelope<AnyRecord> | null, draft: AnyDraft): AnyRecord | undefined {
  return previous?.records.find((record) => record.kind === draft.kind && record.sourceId === draft.sourceId);
}

async function acquireCurrentImage(
  config: StaticBuildConfig,
  draft: AnyDraft,
  fingerprint: string,
  previous: AnyRecord | undefined,
): Promise<{ bytes: Uint8Array; extension: string }> {
  if (
    previous?.image?.fingerprint === fingerprint &&
    withinPreviousBase(previous.image.url, config.previousBaseUrl)
  ) {
    try {
      return await fetchImage(previous.image.url);
    } catch (error) {
      console.warn(`Previous artwork cache miss for ${draft.kind}:${draft.sourceId}: ${errorMessage(error)}`);
    }
  }
  const source = draft.sourceArtwork;
  if (!source || !sourceImageAllowed(source.url)) throw new Error("Artwork source host is not allowlisted");
  return fetchImage(source.url);
}

async function persistImage(
  config: StaticBuildConfig,
  kind: string,
  sourceId: string,
  fingerprint: string,
  image: { bytes: Uint8Array; extension: string },
): Promise<string> {
  const relativePath = `media/${safeSegment(kind)}/${safeSegment(sourceId)}/${fingerprint}.${image.extension}`;
  const destination = outputPath(config, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, image.bytes);
  return publicUrl(config, relativePath);
}

async function hydrateDraft(
  config: StaticBuildConfig,
  draft: AnyDraft,
  previousEnvelope: StreamEnvelope<AnyRecord> | null,
): Promise<AnyRecord> {
  const previous = priorRecord(previousEnvelope, draft);
  const fingerprint = await imageFingerprint(draft);
  let image: Artwork | null = null;
  if (draft.sourceArtwork && fingerprint) {
    const binary = await acquireCurrentImage(config, draft, fingerprint, previous);
    const url = await persistImage(config, draft.kind, draft.sourceId, fingerprint, binary);
    image = {
      url,
      alt: `${draft.displayTitle} ${draft.kind === "event" ? "event photo" : "artwork"}`,
      fingerprint,
      sourceField: draft.sourceArtwork.field,
      sourceUrl: draft.sourceArtwork.url,
      sourceExpiresAt: draft.sourceArtwork.expiresAt,
    };
  }
  const { sourceArtwork: _sourceArtwork, ...record } = draft;
  const recordVersion = (
    await sha256(JSON.stringify({ ...record, imageFingerprint: image?.fingerprint || null }))
  ).slice(0, 32);
  return { ...record, image, recordVersion } as AnyRecord;
}

async function hydrateDrafts(
  config: StaticBuildConfig,
  drafts: AnyDraft[],
  previousEnvelope: StreamEnvelope<AnyRecord> | null,
  concurrency = 4,
): Promise<AnyRecord[]> {
  const records = new Array<AnyRecord>(drafts.length);
  let index = 0;
  async function worker(): Promise<void> {
    while (index < drafts.length) {
      const current = index;
      index += 1;
      const draft = drafts[current];
      if (draft) records[current] = await hydrateDraft(config, draft, previousEnvelope);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(drafts.length, 1)) }, () => worker()));
  return records;
}

function validEnvelope(value: unknown, stream: StreamName): value is StreamEnvelope<AnyRecord> {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Partial<StreamEnvelope<AnyRecord>>;
  return (
    envelope.schemaVersion === 1 &&
    envelope.stream === stream &&
    typeof envelope.sourceFetchedAt === "string" &&
    Number.isFinite(Date.parse(envelope.sourceFetchedAt)) &&
    Array.isArray(envelope.records) &&
    envelope.records.length <= 100
  );
}

async function loadPreviousEnvelope(
  config: StaticBuildConfig,
  stream: StreamName,
): Promise<StreamEnvelope<AnyRecord> | null> {
  const url = new URL(`v1/${stream}.json`, config.previousBaseUrl);
  url.searchParams.set("previous", String(Date.now()));
  try {
    const response = await timedFetch(url.toString(), {
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "follow",
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as unknown;
    return validEnvelope(payload, stream) ? payload : null;
  } catch {
    return null;
  }
}

async function materializePreviousRecords(
  config: StaticBuildConfig,
  stream: StreamName,
  previous: StreamEnvelope<AnyRecord>,
): Promise<AnyRecord[]> {
  const sourceRecords = stream === "events"
    ? filterExpiredEvents(previous.records as EventRecord[], new Date())
    : previous.records;
  const output: AnyRecord[] = [];
  for (const record of sourceRecords) {
    if (!record.image) {
      output.push(record);
      continue;
    }
    let binary: { bytes: Uint8Array; extension: string } | null = null;
    if (withinPreviousBase(record.image.url, config.previousBaseUrl)) {
      try {
        binary = await fetchImage(record.image.url);
      } catch {
        binary = null;
      }
    }
    if (!binary) throw new Error(`Unable to preserve previous artwork for ${record.kind}:${record.sourceId}`);
    const url = await persistImage(config, record.kind, record.sourceId, record.image.fingerprint, binary);
    output.push({ ...record, image: { ...record.image, url } } as AnyRecord);
  }
  return output;
}

function publishedEnvelope<T extends AnyRecord>(
  envelope: StreamEnvelope<T>,
): StreamEnvelope<PublishedRecord<T>> {
  return {
    ...envelope,
    records: envelope.records.map((record) => {
      if (!record.image) return record as unknown as PublishedRecord<T>;
      const { sourceUrl: _sourceUrl, sourceExpiresAt: _sourceExpiresAt, ...image } = record.image;
      return { ...record, image } as unknown as PublishedRecord<T>;
    }),
  };
}

function assertCollection(document: JsonApiDocument, stream: "events" | "messages"): void {
  if (!Array.isArray(document.data)) throw new Error(`Church Center ${stream} response is not a collection`);
}

function assertNormalized(document: JsonApiDocument, drafts: AnyDraft[], stream: StreamName): void {
  const count = Array.isArray(document.data) ? document.data.length : document.data ? 1 : 0;
  if (count > 0 && drafts.length === 0 && stream !== "series") {
    throw new Error(`Church Center returned ${count} ${stream} resources but none passed validation`);
  }
}

async function freshDrafts(
  client: ChurchCenterClient,
  stream: StreamName,
  fetchedAt: string,
): Promise<AnyDraft[]> {
  if (stream === "events") {
    const document = await client.events();
    assertCollection(document, "events");
    const drafts = normalizeEvents(document, new Date(fetchedAt));
    assertNormalized(document, drafts, stream);
    return drafts;
  }
  if (stream === "messages") {
    const document = await client.messages();
    assertCollection(document, "messages");
    const drafts = normalizeMessages(document);
    assertNormalized(document, drafts, stream);
    return drafts;
  }
  const document = await client.featuredSeries();
  if (Array.isArray(document.data) || !document.data) throw new Error("Church Center series response is not a channel");
  return normalizeSeries(document, client.channelId);
}

async function buildStream(
  config: StaticBuildConfig,
  client: ChurchCenterClient,
  stream: StreamName,
  fetchedAt: string,
  previous: StreamEnvelope<AnyRecord> | null,
): Promise<StreamEnvelope<AnyRecord>> {
  try {
    const drafts = await freshDrafts(client, stream, fetchedAt);
    const records = await hydrateDrafts(config, drafts, previous);
    return {
      schemaVersion: 1,
      stream,
      generatedAt: fetchedAt,
      status: "live",
      sourceFetchedAt: fetchedAt,
      staleAfterSeconds: config.staleAfterSeconds,
      records,
    };
  } catch (error) {
    if (!previous) throw new Error(`${stream} refresh failed without a previous deployment: ${errorMessage(error)}`);
    console.warn(`${stream} refresh failed; preserving previous records: ${errorMessage(error)}`);
    const records = await materializePreviousRecords(config, stream, previous);
    return {
      schemaVersion: 1,
      stream,
      generatedAt: fetchedAt,
      status: "stale",
      sourceFetchedAt: previous.sourceFetchedAt,
      staleAfterSeconds: config.staleAfterSeconds,
      records,
    };
  }
}

function worstStatus(envelopes: Array<StreamEnvelope<AnyRecord>>): FeedStatus {
  if (envelopes.some((envelope) => envelope.status === "unavailable")) return "unavailable";
  if (envelopes.some((envelope) => envelope.status === "stale")) return "stale";
  return "live";
}

function staticJavascript(payload: StaticPayload): string {
  const serialized = JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `(function(root){"use strict";root.GNCOFeedStatic=${serialized};})(window);\n`;
}

function statusPage(payload: StaticPayload): string {
  const rows = Object.values(payload.streams)
    .map((stream) => `<tr><th scope="row">${stream.stream}</th><td>${stream.status}</td><td>${stream.records.length}</td><td>${stream.sourceFetchedAt || "never"}</td></tr>`)
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GNCO public feed status</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:62rem;margin:3rem auto;padding:0 1rem;color:#242321}table{border-collapse:collapse;width:100%}th,td{border:1px solid #aaa;padding:.65rem;text-align:left}code{overflow-wrap:anywhere}</style></head>
<body><main><h1>GNCO public feed status</h1><p>This static site contains public event and message metadata used by goodnewsco.church. It collects no visitor form data.</p><p>Generated: <code>${payload.generatedAt}</code></p><table><thead><tr><th>Stream</th><th>Status</th><th>Records</th><th>Source fetched</th></tr></thead><tbody>${rows}</tbody></table></main></body></html>\n`;
}

async function main(): Promise<void> {
  const config = buildConfig();
  assertSafeOutputDirectory(config.outputDirectory);
  await rm(config.outputDirectory, { recursive: true, force: true });
  await mkdir(config.outputDirectory, { recursive: true });

  const fetchedAt = new Date().toISOString();
  const client = new ChurchCenterClient({
    CHANNEL_ID: config.channelId,
    CC_USER_AGENT: config.userAgent,
  } as Env);
  const streamNames: StreamName[] = ["events", "messages", "series"];
  const previousEntries = await Promise.all(
    streamNames.map(async (stream) => [stream, await loadPreviousEnvelope(config, stream)] as const),
  );
  const previous = Object.fromEntries(previousEntries) as Record<StreamName, StreamEnvelope<AnyRecord> | null>;
  const [events, messages, series] = await Promise.all([
    buildStream(config, client, "events", fetchedAt, previous.events),
    buildStream(config, client, "messages", fetchedAt, previous.messages),
    buildStream(config, client, "series", fetchedAt, previous.series),
  ]);
  const publishedEvents = publishedEnvelope(events as StreamEnvelope<EventRecord>);
  const publishedMessages = publishedEnvelope(messages);
  const publishedSeries = publishedEnvelope(series);

  const payload: StaticPayload = {
    schemaVersion: 1,
    generatedAt: fetchedAt,
    baseUrl: config.publicBaseUrl.toString(),
    streams: {
      events: publishedEvents,
      messages: publishedMessages,
      series: publishedSeries,
    },
  };
  const combinedStatus = worstStatus([events, messages, series]);
  const required = [events, messages];
  const healthOk = required.every((envelope) => {
    if (!envelope.sourceFetchedAt) return false;
    return (Date.now() - Date.parse(envelope.sourceFetchedAt)) / 1_000 <= config.healthMaximumAgeSeconds;
  });
  const health = {
    ok: healthOk,
    status: healthOk ? combinedStatus : "unhealthy",
    checkedAt: fetchedAt,
    maximumSourceAgeSeconds: config.healthMaximumAgeSeconds,
    streams: Object.fromEntries(
      [events, messages, series].map((envelope) => [
        envelope.stream,
        {
          status: envelope.status,
          sourceFetchedAt: envelope.sourceFetchedAt,
          records: envelope.records.length,
        },
      ]),
    ),
  };

  await Promise.all([
    writeJson(config, "v1/events.json", publishedEvents),
    writeJson(config, "v1/messages.json", publishedMessages),
    writeJson(config, "v1/series.json", publishedSeries),
    writeJson(config, "v1/live-content.json", {
      schemaVersion: 1,
      generatedAt: fetchedAt,
      status: combinedStatus,
      events: publishedEvents,
      messages: publishedMessages,
      series: publishedSeries,
    }),
    writeJson(config, "health.json", health),
    writeJson(config, "manifest.json", {
      schemaVersion: 1,
      generatedAt: fetchedAt,
      endpoints: ["v1/events.json", "v1/messages.json", "v1/series.json", "v1/live-content.json", "health.json"],
      renderer: "gnco-feed-renderer.js",
      staticData: "gnco-feed-data.js",
    }),
    writeText(config, "gnco-feed-data.js", staticJavascript(payload)),
    writeText(config, "index.html", statusPage(payload)),
    writeText(config, ".nojekyll", ""),
  ]);
  await copyFile(
    resolve(SERVICE_DIR, "public/gnco-feed-renderer.js"),
    outputPath(config, "gnco-feed-renderer.js"),
  );

  for (const envelope of [events, messages, series]) {
    console.log(`${envelope.stream}: ${envelope.status}, ${envelope.records.length} records`);
  }
  console.log(`Static feed written to ${config.outputDirectory}`);
}

main().catch((error) => {
  console.error(`Static feed build failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
