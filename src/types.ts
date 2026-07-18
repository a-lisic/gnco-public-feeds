export type StreamName = "events" | "messages" | "series";
export type FeedStatus = "live" | "stale" | "unavailable";

export interface Env {
  CHANNEL_ID?: string;
  CC_USER_AGENT?: string;
}

export interface SourceArtwork {
  field: string;
  url: string;
  fingerprintSeed?: string;
  expiresAt: string | null;
}

export interface Artwork {
  url: string;
  alt: string;
  fingerprint: string;
  sourceField: string;
  sourceUrl: string;
  sourceExpiresAt: string | null;
}

export interface EventRecord {
  kind: "event";
  source: "planning-center-calendar";
  sourceId: string;
  sourceTitle: string;
  displayTitle: string;
  description: string | null;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  featured: boolean;
  location: string | null;
  categoryTags: string[];
  campusTags: string[];
  url: string;
  registrationUrl: string | null;
  image: Artwork | null;
  recordVersion: string;
}

export interface MessageSeries {
  sourceId: string;
  title: string;
  url: string | null;
}

export interface MessageRecord {
  kind: "message";
  source: "planning-center-publishing";
  sourceId: string;
  sourceTitle: string;
  displayTitle: string;
  description: string | null;
  excerpt: string | null;
  publishedAt: string;
  speakers: string[];
  series: MessageSeries | null;
  url: string;
  notesUrl: string | null;
  image: Artwork | null;
  recordVersion: string;
}

export interface SeriesRecord {
  kind: "series";
  source: "planning-center-publishing";
  sourceId: string;
  sourceTitle: string;
  displayTitle: string;
  description: string | null;
  url: string | null;
  image: Artwork | null;
  recordVersion: string;
}

export interface StreamEnvelope<T> {
  schemaVersion: 1;
  stream: StreamName;
  generatedAt: string;
  status: FeedStatus;
  sourceFetchedAt: string | null;
  staleAfterSeconds: number;
  records: T[];
}

export interface EventDraft extends Omit<EventRecord, "image" | "recordVersion"> {
  sourceArtwork: SourceArtwork | null;
}

export interface MessageDraft extends Omit<MessageRecord, "image" | "recordVersion"> {
  sourceArtwork: SourceArtwork | null;
}

export interface SeriesDraft extends Omit<SeriesRecord, "image" | "recordVersion"> {
  sourceArtwork: SourceArtwork | null;
}

export type AnyDraft = EventDraft | MessageDraft | SeriesDraft;
export type AnyRecord = EventRecord | MessageRecord | SeriesRecord;

export interface JsonApiResource {
  type?: string;
  id?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<
    string,
    {
      data?: { type?: string; id?: string } | Array<{ type?: string; id?: string }> | null;
    }
  >;
}

export interface JsonApiDocument {
  data?: JsonApiResource | JsonApiResource[];
  included?: JsonApiResource[];
}
