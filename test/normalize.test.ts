import { describe, expect, it } from "vitest";
import { filterExpiredEvents, normalizeEvents, normalizeMessages, normalizeSeries } from "../src/normalize";
import type { JsonApiDocument } from "../src/types";
import { canonicalArtworkSeed } from "../src/util";

describe("event normalization", () => {
  it("keeps each event's exact data and filters events that have ended", () => {
    const document: JsonApiDocument = {
      data: [
        {
          type: "Event",
          id: "event-current",
          attributes: {
            name: "  Outdoor Baptisms  ",
            description: "A public celebration.",
            starts_at: "2026-07-19T18:00:00.000Z",
            ends_at: "2026-07-19T20:00:00.000Z",
            image_url: "https://files.example/event-current.jpg?key=own-art&expires_at=1785600000&signature=abc",
            public_url: "https://goodnewsco.churchcenter.com/calendar/event/event-current",
            featured: true,
          },
          relationships: {
            location: { data: { type: "Location", id: "location-current" } },
            event_registration_url: { data: { type: "EventRegistrationUrl", id: "registration-current" } },
            category_tags: { data: [{ type: "CategoryTag", id: "category-current" }] },
          },
        },
        {
          type: "Event",
          id: "event-ended",
          attributes: {
            name: "Ended Event",
            starts_at: "2026-07-10T18:00:00.000Z",
            ends_at: "2026-07-10T19:00:00.000Z",
            image_url: "https://files.example/wrong-event.jpg",
          },
        },
      ],
      included: [
        { type: "Location", id: "location-current", attributes: { name: "The Roe's Pool" } },
        {
          type: "EventRegistrationUrl",
          id: "registration-current",
          attributes: { url: "https://goodnewsco.churchcenter.com/registrations/events/3425871" },
        },
        { type: "CategoryTag", id: "category-current", attributes: { name: "Next Steps" } },
        {
          type: "EventRegistrationUrl",
          id: "registration-other",
          attributes: { url: "https://example.com/wrong-registration" },
        },
      ],
    };

    const events = normalizeEvents(document, new Date("2026-07-18T12:00:00.000Z"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sourceId: "event-current",
      sourceTitle: "  Outdoor Baptisms  ",
      displayTitle: "Outdoor Baptisms",
      location: "The Roe's Pool",
      categoryTags: ["Next Steps"],
      url: "https://goodnewsco.churchcenter.com/calendar/event/event-current",
      registrationUrl: "https://goodnewsco.churchcenter.com/registrations/events/3425871",
      sourceArtwork: {
        field: "image_url",
        url: "https://files.example/event-current.jpg?key=own-art&expires_at=1785600000&signature=abc",
      },
    });
  });

  it("filters persisted events again at response time", () => {
    const records = [
      { startsAt: "2026-07-18T10:00:00.000Z", endsAt: "2026-07-18T11:00:00.000Z", id: "ended" },
      { startsAt: "2026-07-18T20:00:00.000Z", endsAt: null, id: "upcoming" },
    ];
    expect(filterExpiredEvents(records, new Date("2026-07-18T12:00:00.000Z"))).toEqual([records[1]]);
  });
});

describe("message normalization", () => {
  it("does not rewrite titles or cross-wire episode artwork, speakers, or series", () => {
    const document: JsonApiDocument = {
      data: [
        {
          type: "Episode",
          id: "episode-1",
          attributes: {
            title: "The Lie of More - Enough Week 1",
            description: "What if the life we are chasing can never give us what only Jesus can?",
            published_to_library_at: "2026-07-12T15:00:00.000Z",
            library_art_url: "https://files.example/episode-1.jpg?expires_at=1785600000&signature=one",
            church_center_url: "https://goodnewsco.churchcenter.com/episodes/episode-1",
          },
          relationships: {
            speaker: { data: [{ type: "Speaker", id: "speaker-1" }] },
            series: { data: { type: "Series", id: "series-1" } },
          },
        },
        {
          type: "Episode",
          id: "episode-2",
          attributes: {
            title: "No Turning Back",
            published_to_library_at: "2026-07-05T15:00:00.000Z",
            library_art_url: "https://files.example/episode-2.jpg?expires_at=1785600000&signature=two",
          },
          relationships: {
            speaker: { data: [{ type: "Speaker", id: "speaker-2" }] },
            series: { data: null },
          },
        },
      ],
      included: [
        { type: "Speaker", id: "speaker-1", attributes: { formatted_name: "Alex Lisic" } },
        { type: "Speaker", id: "speaker-2", attributes: { formatted_name: "Nick Jankowski" } },
        {
          type: "Series",
          id: "series-1",
          attributes: {
            title: "Enough",
            church_center_url: "https://goodnewsco.churchcenter.com/channels/25787/series/series-1",
          },
        },
      ],
    };

    const messages = normalizeMessages(document);
    expect(messages[0]).toMatchObject({
      sourceId: "episode-1",
      sourceTitle: "The Lie of More - Enough Week 1",
      displayTitle: "The Lie of More - Enough Week 1",
      speakers: ["Alex Lisic"],
      series: { sourceId: "series-1", title: "Enough" },
      sourceArtwork: { url: "https://files.example/episode-1.jpg?expires_at=1785600000&signature=one" },
    });
    expect(messages[1]).toMatchObject({
      sourceId: "episode-2",
      speakers: ["Nick Jankowski"],
      series: null,
      sourceArtwork: { url: "https://files.example/episode-2.jpg?expires_at=1785600000&signature=two" },
    });
  });
});

describe("featured series normalization", () => {
  it("uses the artwork that belongs to each featured series", () => {
    const document: JsonApiDocument = {
      data: {
        type: "Channel",
        id: "25787",
        relationships: {
          featured_series: { data: [{ type: "Series", id: "series-1" }] },
        },
      },
      included: [
        {
          type: "Series",
          id: "series-1",
          attributes: {
            title: "Enough",
            art: { attributes: { signed_identifier: "enough-art", variants: { medium: "https://files.example/enough.jpg" } } },
          },
        },
      ],
    };
    expect(normalizeSeries(document, "25787")[0]).toMatchObject({
      sourceId: "series-1",
      sourceTitle: "Enough",
      sourceArtwork: {
        field: "art.attributes.variants.medium",
        url: "https://files.example/enough.jpg",
        fingerprintSeed: "enough-art",
      },
    });
  });
});

describe("signed artwork identity", () => {
  it("ignores only the rotating signature and expiry", () => {
    const first = canonicalArtworkSeed(
      "https://files.example/transform.jpg?key=asset-123&thumb=1200x675&expires_at=100&signature=abc",
    );
    const second = canonicalArtworkSeed(
      "https://files.example/transform.jpg?key=asset-123&thumb=1200x675&expires_at=200&signature=xyz",
    );
    expect(first).toBe(second);
    expect(first).toContain("key=asset-123");
    expect(first).toContain("thumb=1200x675");
  });
});
