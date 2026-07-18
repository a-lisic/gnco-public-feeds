import type {
  EventDraft,
  JsonApiDocument,
  JsonApiResource,
  MessageDraft,
  SeriesDraft,
  SourceArtwork,
} from "./types";
import {
  absoluteChurchCenterUrl,
  excerpt,
  logError,
  optionalBoolean,
  optionalString,
  requiredString,
  safeHttpsUrl,
  sourceExpiry,
  validIsoDate,
} from "./util";

const CHURCH_CENTER_ORIGIN = "https://goodnewsco.churchcenter.com";

function resources(document: JsonApiDocument): JsonApiResource[] {
  return Array.isArray(document.data) ? document.data : [];
}

function attributes(resource: JsonApiResource): Record<string, unknown> {
  return resource.attributes && typeof resource.attributes === "object" ? resource.attributes : {};
}

function relationshipRefs(resource: JsonApiResource, name: string): Array<{ type?: string; id?: string }> {
  const data = resource.relationships?.[name]?.data;
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

function includedByRef(
  document: JsonApiDocument,
  reference: { type?: string; id?: string } | undefined,
): JsonApiResource | undefined {
  if (!reference?.id) return undefined;
  return document.included?.find(
    (item) => item.id === reference.id && (!reference.type || !item.type || item.type === reference.type),
  );
}

function relationshipResources(document: JsonApiDocument, resource: JsonApiResource, name: string): JsonApiResource[] {
  return relationshipRefs(resource, name)
    .map((reference) => includedByRef(document, reference))
    .filter((item): item is JsonApiResource => Boolean(item));
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nestedString(value: unknown, path: string[]): string | null {
  let cursor: unknown = value;
  for (const segment of path) {
    const record = nestedRecord(cursor);
    if (!record) return null;
    cursor = record[segment];
  }
  return optionalString(cursor);
}

function sourceArtwork(field: string, rawUrl: unknown, fingerprintSeed?: string | null): SourceArtwork | null {
  const url = safeHttpsUrl(rawUrl);
  if (!url) return null;
  return {
    field,
    url,
    fingerprintSeed: fingerprintSeed || undefined,
    expiresAt: sourceExpiry(url),
  };
}

function eventArtwork(a: Record<string, unknown>): SourceArtwork | null {
  return sourceArtwork("image_url", a.image_url) || sourceArtwork("open_graph_image_url", a.open_graph_image_url);
}

function publishingArtwork(a: Record<string, unknown>): SourceArtwork | null {
  const artIdentity =
    nestedString(a.art, ["id"]) ||
    nestedString(a.art, ["attributes", "signed_identifier"]) ||
    nestedString(a.art, ["attributes", "id"]);
  return (
    sourceArtwork("library_art_url", a.library_art_url, artIdentity) ||
    sourceArtwork("art.attributes.variants.medium", nestedString(a.art, ["attributes", "variants", "medium"]), artIdentity) ||
    sourceArtwork("library_video_thumbnail_url", a.library_video_thumbnail_url)
  );
}

function titlePair(resource: JsonApiResource, field: "name" | "title"): { sourceTitle: string; displayTitle: string } {
  const sourceTitle = requiredString(attributes(resource)[field], `${resource.type || "resource"}.${field}`);
  const displayTitle = sourceTitle.trim();
  if (!displayTitle) throw new Error(`Blank ${resource.type || "resource"}.${field}`);
  return { sourceTitle, displayTitle };
}

function relationshipNames(
  document: JsonApiDocument,
  resource: JsonApiResource,
  relationship: string,
  fields: string[],
): string[] {
  return relationshipResources(document, resource, relationship)
    .map((related) => {
      const a = attributes(related);
      for (const field of fields) {
        const value = optionalString(a[field]);
        if (value) return value.trim();
      }
      return null;
    })
    .filter((value): value is string => Boolean(value));
}

function eventRegistrationUrl(document: JsonApiDocument, event: JsonApiResource): string | null {
  const registration = relationshipResources(document, event, "event_registration_url")[0];
  return registration ? safeHttpsUrl(attributes(registration).url) : null;
}

function eventUrl(event: JsonApiResource, a: Record<string, unknown>): string {
  return (
    safeHttpsUrl(a.public_url) ||
    absoluteChurchCenterUrl(a.show_page_path) ||
    `${CHURCH_CENTER_ORIGIN}/calendar/event/${encodeURIComponent(requiredString(event.id, "Event.id"))}`
  );
}

function isEventActive(startsAt: string, endsAt: string | null, now: Date): boolean {
  const cutoff = Date.parse(endsAt || startsAt);
  return Number.isFinite(cutoff) && cutoff > now.getTime();
}

export function normalizeEvents(document: JsonApiDocument, now = new Date()): EventDraft[] {
  const output: EventDraft[] = [];
  for (const event of resources(document)) {
    if (event.type && event.type !== "Event") continue;
    try {
      const a = attributes(event);
      const id = requiredString(event.id, "Event.id");
      const { sourceTitle, displayTitle } = titlePair(event, "name");
      const startsAt = validIsoDate(a.starts_at, "Event.starts_at");
      const endsAtValue = optionalString(a.ends_at);
      const endsAt = endsAtValue ? validIsoDate(endsAtValue, "Event.ends_at") : null;
      if (!isEventActive(startsAt, endsAt, now)) continue;

      const location = relationshipNames(document, event, "location", ["name"])[0] || null;
      const description = optionalString(a.description) || optionalString(a.details);
      output.push({
        kind: "event",
        source: "planning-center-calendar",
        sourceId: id,
        sourceTitle,
        displayTitle,
        description,
        startsAt,
        endsAt,
        allDay: optionalBoolean(a.all_day_event),
        featured: optionalBoolean(a.featured),
        location,
        categoryTags: relationshipNames(document, event, "category_tags", ["name"]),
        campusTags: relationshipNames(document, event, "campus_tags", ["name"]),
        url: eventUrl(event, a),
        registrationUrl: eventRegistrationUrl(document, event),
        sourceArtwork: eventArtwork(a),
      });
    } catch (error) {
      logError("normalize.event", error, { sourceId: event.id || null });
    }
  }
  return output.sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
}

function findSpeakers(document: JsonApiDocument, episode: JsonApiResource): string[] {
  const direct = relationshipNames(document, episode, "speaker", ["formatted_name", "name"]);
  if (direct.length > 0) return direct;

  const throughSpeakerships = relationshipResources(document, episode, "speakerships").flatMap((speakership) =>
    relationshipNames(document, speakership, "speaker", ["formatted_name", "name"]),
  );
  return [...new Set(throughSpeakerships)];
}

function messageSeries(document: JsonApiDocument, episode: JsonApiResource) {
  const series = relationshipResources(document, episode, "series")[0];
  if (!series?.id) return null;
  const a = attributes(series);
  const title = optionalString(a.title)?.trim();
  if (!title) return null;
  return {
    sourceId: series.id,
    title,
    url: safeHttpsUrl(a.church_center_url),
  };
}

export function normalizeMessages(document: JsonApiDocument): MessageDraft[] {
  const output: MessageDraft[] = [];
  for (const episode of resources(document)) {
    if (episode.type && episode.type !== "Episode") continue;
    try {
      const a = attributes(episode);
      const id = requiredString(episode.id, "Episode.id");
      const { sourceTitle, displayTitle } = titlePair(episode, "title");
      const publishedAt = validIsoDate(a.published_to_library_at, "Episode.published_to_library_at");
      const url =
        safeHttpsUrl(a.church_center_url) || `${CHURCH_CENTER_ORIGIN}/episodes/${encodeURIComponent(id)}`;
      const description = optionalString(a.description);
      output.push({
        kind: "message",
        source: "planning-center-publishing",
        sourceId: id,
        sourceTitle,
        displayTitle,
        description,
        excerpt: excerpt(description),
        publishedAt,
        speakers: findSpeakers(document, episode),
        series: messageSeries(document, episode),
        url,
        notesUrl: safeHttpsUrl(a.notes_url) || `${url.replace(/\/$/, "")}/notes`,
        sourceArtwork: publishingArtwork(a),
      });
    } catch (error) {
      logError("normalize.message", error, { sourceId: episode.id || null });
    }
  }
  return output.sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt));
}

export function normalizeSeries(document: JsonApiDocument, channelId: string): SeriesDraft[] {
  const channel = Array.isArray(document.data) ? null : document.data;
  if (!channel) return [];
  const output: SeriesDraft[] = [];
  for (const series of relationshipResources(document, channel, "featured_series")) {
    try {
      const a = attributes(series);
      const id = requiredString(series.id, "Series.id");
      const { sourceTitle, displayTitle } = titlePair(series, "title");
      output.push({
        kind: "series",
        source: "planning-center-publishing",
        sourceId: id,
        sourceTitle,
        displayTitle,
        description: optionalString(a.description),
        url:
          safeHttpsUrl(a.church_center_url) ||
          `${CHURCH_CENTER_ORIGIN}/channels/${encodeURIComponent(channelId)}/series/${encodeURIComponent(id)}`,
        sourceArtwork: publishingArtwork(a),
      });
    } catch (error) {
      logError("normalize.series", error, { sourceId: series.id || null });
    }
  }
  return output;
}

export function filterExpiredEvents<T extends { startsAt: string; endsAt: string | null }>(
  events: T[],
  now = new Date(),
): T[] {
  return events.filter((event) => isEventActive(event.startsAt, event.endsAt, now));
}
