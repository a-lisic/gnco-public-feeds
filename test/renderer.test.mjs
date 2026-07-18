import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

const rendererSource = readFileSync(new URL("../public/gnco-feed-renderer.js", import.meta.url), "utf8");
const openDoms = [];

afterEach(() => {
  while (openDoms.length) openDoms.pop().window.close();
});

function eventRecord(id, title, imageSuffix = id) {
  const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const endsAt = new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString();
  return {
    kind: "event",
    sourceId: id,
    sourceTitle: title,
    displayTitle: title,
    description: `${title} description`,
    startsAt,
    endsAt,
    allDay: false,
    location: "GNCO Auditorium",
    url: `https://goodnewsco.churchcenter.com/calendar/event/${id}`,
    registrationUrl: null,
    image: {
      url: `https://feeds.goodnewsco.church/v1/media/event/${id}/${imageSuffix}`,
      alt: `${title} source artwork`,
      sourceUrl: `https://signed-source.example/${id}.jpg?signature=private-rotation`,
    },
  };
}

function messageRecord(id, title) {
  return {
    kind: "message",
    sourceId: id,
    sourceTitle: title,
    displayTitle: title,
    description: `${title} description`,
    excerpt: `${title} excerpt`,
    publishedAt: "2026-07-12T15:00:00.000Z",
    speakers: ["Alex Lisic"],
    series: { sourceId: "series-1", title: "Enough" },
    url: `https://goodnewsco.churchcenter.com/episodes/${id}`,
    notesUrl: `https://goodnewsco.churchcenter.com/episodes/${id}/notes`,
    image: {
      url: `https://feeds.goodnewsco.church/v1/media/message/${id}/art-${id}`,
      alt: `${title} artwork`,
    },
  };
}

function seriesRecord(id, title) {
  return {
    kind: "series",
    sourceId: id,
    sourceTitle: title,
    displayTitle: title,
    description: `${title} description`,
    url: `https://goodnewsco.churchcenter.com/channels/25787/series/${id}`,
    image: {
      url: `https://feeds.goodnewsco.church/v1/media/series/${id}/art-${id}`,
      alt: `${title} artwork`,
    },
  };
}

function envelope(stream, records, status = "live") {
  return { schemaVersion: 1, stream, generatedAt: "2026-07-18T12:00:00.000Z", status, records };
}

function response(payload) {
  return {
    ok: true,
    headers: { get: () => "application/json; charset=utf-8" },
    json: async () => payload,
  };
}

async function render(html, feedByPath, options = {}) {
  const fetchMock = options.fetchMock || vi.fn(async (input) => {
    const path = new URL(String(input)).pathname;
    if (!(path in feedByPath)) throw new Error(`Unexpected path ${path}`);
    return response(feedByPath[path]);
  });
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body>
      <script data-gnco-renderer
        ${options.scriptAttributes || `data-gnco-feed-base="https://feeds.goodnewsco.church"
        data-gnco-feed-hosts="feeds.goodnewsco.church"
        data-gnco-image-hosts="feeds.goodnewsco.church"
        data-gnco-link-hosts="goodnewsco.churchcenter.com,goodnewsco.church,www.goodnewsco.church"`}></script>
      ${html}
    </body></html>`,
    { url: "https://goodnewsco.church/", runScripts: "outside-only" },
  );
  openDoms.push(dom);
  Object.defineProperty(dom.window, "fetch", { configurable: true, value: fetchMock });
  dom.window.AbortController = globalThis.AbortController;
  if (options.staticData) dom.window.GNCOFeedStatic = options.staticData;
  dom.window.eval(rendererSource);
  await dom.window.GNCOFeeds.mountAll();
  return { dom, document: dom.window.document, fetchMock };
}

describe("standalone Squarespace renderer", () => {
  it("supports all five mount types with shared endpoint requests and per-mount limits", async () => {
    const events = [1, 2, 3, 4].map((number) => eventRecord(`event-${number}`, `Event ${number}`));
    const messages = [messageRecord("message-1", "Message One"), messageRecord("message-2", "Message Two")];
    const series = [seriesRecord("series-1", "Enough"), seriesRecord("series-2", "Church Core")];
    const mounts = [
      '<div id="home" data-gnco-feed="home-events"><div data-gnco-native>Home fallback</div></div>',
      '<div id="latest" data-gnco-feed="latest-message"><div data-gnco-native>Latest fallback</div></div>',
      '<div id="events" data-gnco-feed="events"><div data-gnco-native>Events fallback</div></div>',
      '<div id="messages" data-gnco-feed="messages"><div data-gnco-native>Messages fallback</div></div>',
      '<div id="series" data-gnco-feed="series"><div data-gnco-native>Series fallback</div></div>',
    ].join("");
    const { document, fetchMock } = await render(mounts, {
      "/v1/events": envelope("events", events),
      "/v1/messages": envelope("messages", messages),
      "/v1/series": envelope("series", series),
    });

    expect(document.querySelectorAll("#home .gnco-feed-card")).toHaveLength(3);
    expect(document.querySelectorAll("#latest .gnco-feed-card")).toHaveLength(1);
    expect(document.querySelectorAll("#events .gnco-feed-card")).toHaveLength(4);
    expect(document.querySelectorAll("#messages .gnco-feed-card")).toHaveLength(2);
    expect(document.querySelectorAll("#series .gnco-feed-card")).toHaveLength(2);
    expect(document.querySelectorAll('[data-gnco-feed] [data-gnco-native][hidden]')).toHaveLength(5);
    expect(document.querySelector("#events .gnco-feed__grid").getAttribute("role")).toBe("list");
    expect(document.querySelector("#events .gnco-feed-card").getAttribute("role")).toBe("listitem");

    const requestedPaths = fetchMock.mock.calls.map((call) => new URL(String(call[0])).pathname);
    expect(new Set(requestedPaths)).toEqual(new Set(["/v1/events", "/v1/messages", "/v1/series"]));
  });

  it("uses only each record's stable associated image and never its signed source URL", async () => {
    const first = eventRecord("event-a", "First Event", "first-art");
    const second = eventRecord("event-b", "Second Event", "second-art");
    first.registrationUrl = "https://goodnewsco.churchcenter.com/registrations/events/event-a";
    first.description = '<div class="trix-content"><strong>Real event</strong><br>description &amp; details.</div>';
    const { document } = await render(
      '<div id="events" data-gnco-feed="events"><div data-gnco-native>Fallback</div></div>',
      { "/v1/events": envelope("events", [first, second]) },
    );
    const cards = Array.from(document.querySelectorAll("#events .gnco-feed-card"));
    expect(cards[0].querySelector("img").src).toContain("/event/event-a/first-art");
    expect(cards[0].querySelector("img").alt).toBe("First Event source artwork");
    expect(cards[1].querySelector("img").src).toContain("/event/event-b/second-art");
    expect(cards[0].querySelector(".gnco-feed-card__title-link").href).toContain("/calendar/event/event-a");
    expect(cards[0].querySelector(".gnco-feed-card__action").href).toContain("/registrations/events/event-a");
    expect(cards[0].querySelector(".gnco-feed-card__description").textContent).toBe("Real event description & details.");
    expect(cards[0].querySelector(".gnco-feed-card__description").textContent).not.toContain("trix-content");
    expect(document.body.textContent).not.toContain("private-rotation");
    expect(Array.from(document.images).some((image) => image.src.includes("signed-source.example"))).toBe(false);
  });

  it("renders untrusted text as text and drops non-allowlisted image and link URLs", async () => {
    const unsafe = eventRecord("event-unsafe", '<img src=x onerror="alert(1)">');
    unsafe.url = "https://evil.example/phish";
    unsafe.image.url = "https://evil.example/tracker.jpg";
    const { document } = await render(
      '<div id="unsafe" data-gnco-feed="events"><div data-gnco-native>Fallback</div></div>',
      { "/v1/events": envelope("events", [unsafe]) },
    );
    const card = document.querySelector("#unsafe .gnco-feed-card");
    expect(card.querySelector(".gnco-feed-card__title").textContent).toBe('<img src=x onerror="alert(1)">');
    expect(card.querySelector("img")).toBeNull();
    expect(card.querySelector("a")).toBeNull();
    expect(rendererSource).not.toContain(".innerHTML");
  });

  it("keeps native fallback markup for empty, unavailable, and rejected-base states", async () => {
    const { document, fetchMock } = await render(
      [
        '<div id="empty" data-gnco-feed="events"><div data-gnco-native><strong>Native empty fallback</strong></div></div>',
        '<div id="down" data-gnco-feed="messages"><div data-gnco-native><strong>Native down fallback</strong></div></div>',
        '<div id="rejected" data-gnco-feed="series" data-gnco-feed-base="https://evil.example"><div data-gnco-native><strong>Native rejected fallback</strong></div></div>',
      ].join(""),
      {
        "/v1/events": envelope("events", []),
        "/v1/messages": envelope("messages", [], "unavailable"),
      },
    );

    for (const id of ["empty", "down", "rejected"]) {
      expect(document.querySelector(`#${id} [data-gnco-native]`).hidden).toBe(false);
      expect(document.querySelector(`#${id} [data-gnco-native] strong`)).not.toBeNull();
      expect(document.querySelector(`#${id} .gnco-feed__output`).hidden).toBe(true);
    }
    expect(document.querySelector("#empty").getAttribute("data-gnco-state")).toBe("empty");
    expect(document.querySelector("#down").getAttribute("data-gnco-state")).toBe("unavailable");
    expect(document.querySelector("#rejected").getAttribute("data-gnco-state")).toBe("unavailable");
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("evil.example"))).toBe(false);
  });

  it("restores the exact native fallback node when a later refresh is unavailable", async () => {
    let requestNumber = 0;
    const fetchMock = vi.fn(async () => {
      requestNumber += 1;
      return response(
        requestNumber === 1
          ? envelope("events", [eventRecord("event-live", "Live Event")])
          : envelope("events", [], "unavailable"),
      );
    });
    const { dom, document } = await render(
      '<div id="refresh" data-gnco-feed="events"><div data-gnco-native><a href="https://goodnewsco.churchcenter.com/calendar">Original calendar fallback</a></div></div>',
      {},
      { fetchMock },
    );
    const fallback = document.querySelector("#refresh [data-gnco-native]");
    expect(fallback.hidden).toBe(true);
    await dom.window.GNCOFeeds.refresh(document.querySelector("#refresh"));
    expect(document.querySelector("#refresh [data-gnco-native]")).toBe(fallback);
    expect(fallback.hidden).toBe(false);
    expect(fallback.querySelector("a").textContent).toBe("Original calendar fallback");
  });

  it("preserves a GitHub Pages project base path and requests the static JSON suffix", async () => {
    const { fetchMock } = await render(
      '<div data-gnco-feed="events"><div data-gnco-native>Fallback</div></div>',
      { "/gnco-feed/v1/events.json": envelope("events", [eventRecord("event-pages", "Pages Event")]) },
      {
        scriptAttributes: 'data-gnco-feed-base="https://a-lisic.github.io/gnco-feed/" data-gnco-feed-hosts="a-lisic.github.io" data-gnco-feed-suffix=".json"',
      },
    );
    expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toBe("/gnco-feed/v1/events.json");
  });

  it("can consume the static JavaScript payload without a cross-origin JSON request", async () => {
    const event = eventRecord("event-static", "Static Event");
    event.image.url = "https://a-lisic.github.io/gnco-feed/media/event/event-static/art.jpg";
    const staticData = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      streams: { events: envelope("events", [event]) },
    };
    const { document, fetchMock } = await render(
      '<div id="static" data-gnco-feed="events"><div data-gnco-native>Fallback</div></div>',
      {},
      {
        staticData,
        scriptAttributes: 'data-gnco-feed-base="https://a-lisic.github.io/gnco-feed/" data-gnco-feed-hosts="a-lisic.github.io" data-gnco-image-hosts="a-lisic.github.io" data-gnco-feed-suffix=".json" data-gnco-use-static-data="true"',
      },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector("#static .gnco-feed-card__title").textContent).toBe("Static Event");
  });

  it("marks old static envelopes stale in the browser and removes ended events", async () => {
    const ended = eventRecord("event-ended", "Ended Event");
    ended.startsAt = "2020-01-01T10:00:00.000Z";
    ended.endsAt = "2020-01-01T11:00:00.000Z";
    const current = eventRecord("event-current", "Current Event");
    const oldEnvelope = {
      ...envelope("events", [ended, current]),
      sourceFetchedAt: "2020-01-01T00:00:00.000Z",
      staleAfterSeconds: 60,
    };
    const { document } = await render(
      '<div id="aged" data-gnco-feed="events"><div data-gnco-native>Fallback</div></div>',
      { "/v1/events": oldEnvelope },
    );
    expect(document.querySelector("#aged").getAttribute("data-gnco-state")).toBe("stale");
    expect(document.querySelectorAll("#aged .gnco-feed-card")).toHaveLength(1);
    expect(document.querySelector("#aged .gnco-feed-card__title").textContent).toBe("Current Event");
  });
});
