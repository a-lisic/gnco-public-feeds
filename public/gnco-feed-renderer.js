(function gncoFeedRenderer() {
  "use strict";

  var VERSION = "1.2.1";
  var MOUNT_SELECTOR = "[data-gnco-feed]";
  var HOME_EVENT_EXCLUDED_TITLES = ["sunday worship"];
  var HOME_EVENT_EXCLUDED_CATEGORY_TAGS = ["hide from home"];
  var ENDPOINTS = {
    "home-events": { path: "/v1/events", stream: "events", kind: "event", limit: 3 },
    "latest-message": { path: "/v1/messages", stream: "messages", kind: "message", limit: 1 },
    events: { path: "/v1/events", stream: "events", kind: "event", limit: 24 },
    messages: { path: "/v1/messages", stream: "messages", kind: "message", limit: 12 },
    series: { path: "/v1/series", stream: "series", kind: "series", limit: 12 },
  };
  var DEFAULT_LINK_HOSTS = [
    "goodnewsco.church",
    "www.goodnewsco.church",
    "goodnewsco.churchcenter.com",
  ];
  var fetchCache = new Map();
  var mountInstances = new Map();

  if (window.GNCOFeeds && window.GNCOFeeds.version === VERSION) {
    window.GNCOFeeds.mountAll();
    return;
  }

  var script = document.currentScript || document.querySelector("script[data-gnco-renderer]");
  var scriptConfig = readScriptConfig(script);

  function textAttribute(element, name, fallback) {
    if (!element) return fallback;
    var value = element.getAttribute(name);
    return value === null ? fallback : value.trim();
  }

  function booleanAttribute(element, name, fallback) {
    var value = textAttribute(element, name, "").toLowerCase();
    if (!value) return fallback;
    if (value === "true" || value === "1" || value === "yes") return true;
    if (value === "false" || value === "0" || value === "no") return false;
    return fallback;
  }

  function integerAttribute(element, name, fallback, minimum, maximum) {
    var parsed = Number.parseInt(textAttribute(element, name, ""), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, parsed));
  }

  function suffixAttribute(element, fallback) {
    var value = textAttribute(element, "data-gnco-feed-suffix", fallback);
    return value === ".json" ? ".json" : "";
  }

  function hostList(value) {
    return String(value || "")
      .split(",")
      .map(function normalizeHost(host) {
        return host.trim().toLowerCase().replace(/\.$/, "");
      })
      .filter(function validHost(host) {
        return /^[a-z0-9.-]+$/.test(host) && host.indexOf("..") === -1;
      });
  }

  function unique(values) {
    return Array.from(new Set(values));
  }

  function readScriptConfig(element) {
    return {
      base: textAttribute(element, "data-gnco-feed-base", ""),
      feedHosts: hostList(textAttribute(element, "data-gnco-feed-hosts", "")),
      linkHosts: unique(
        DEFAULT_LINK_HOSTS.concat(hostList(textAttribute(element, "data-gnco-link-hosts", ""))),
      ),
      imageHosts: hostList(textAttribute(element, "data-gnco-image-hosts", "")),
      suffix: suffixAttribute(element, ""),
      useStaticData: booleanAttribute(element, "data-gnco-use-static-data", false),
      timeout: integerAttribute(element, "data-gnco-timeout", 6500, 1000, 15000),
      debug: booleanAttribute(element, "data-gnco-debug", false),
    };
  }

  function safeHttpsUrl(value, allowedHosts) {
    if (typeof value !== "string" || !value) return null;
    try {
      var parsed = new URL(value);
      var hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
      if (parsed.protocol !== "https:") return null;
      if (parsed.username || parsed.password) return null;
      if (parsed.port && parsed.port !== "443") return null;
      if (!allowedHosts.includes(hostname)) return null;
      return parsed.toString();
    } catch (_error) {
      return null;
    }
  }

  function deriveBaseHost(base) {
    try {
      return new URL(base).hostname.toLowerCase().replace(/\.$/, "");
    } catch (_error) {
      return "";
    }
  }

  function pagePath() {
    var pathname = window.location && typeof window.location.pathname === "string"
      ? window.location.pathname
      : "/";
    if (pathname === "/") return pathname;
    return pathname.replace(/\/+$/, "");
  }

  function resolvedHeadingLevel(mountType, requestedLevel) {
    var pathname = pagePath();
    if (
      mountType === "latest-message" &&
      (pathname === "/messages" || pathname === "/messages-native-build")
    ) {
      return 2;
    }
    if (mountType === "home-events") return 3;
    if (
      mountType === "latest-message" &&
      (pathname === "/" || pathname === "/home" || pathname === "/home-2")
    ) {
      return 3;
    }
    return requestedLevel;
  }

  function mountConfig(mount) {
    var mountType = textAttribute(mount, "data-gnco-feed", "");
    var definition = ENDPOINTS[mountType];
    if (!definition) throw new Error("Unsupported GNCO feed mount type");

    var base = textAttribute(mount, "data-gnco-feed-base", scriptConfig.base);
    var configuredFeedHosts = hostList(
      textAttribute(mount, "data-gnco-feed-hosts", scriptConfig.feedHosts.join(",")),
    );
    var derivedBaseHost = deriveBaseHost(base);
    var feedHosts = configuredFeedHosts.length ? configuredFeedHosts : derivedBaseHost ? [derivedBaseHost] : [];
    var safeBase = safeHttpsUrl(base, feedHosts);
    if (!safeBase) throw new Error("GNCO feed base must be an allowlisted HTTPS origin");

    var suffix = suffixAttribute(mount, scriptConfig.suffix);
    var baseRoot = new URL(safeBase);
    baseRoot.search = "";
    baseRoot.hash = "";
    if (!baseRoot.pathname.endsWith("/")) baseRoot.pathname += "/";
    var baseUrl = new URL(definition.path.replace(/^\//, "") + suffix, baseRoot);

    var linkHosts = unique(
      scriptConfig.linkHosts.concat(
        hostList(textAttribute(mount, "data-gnco-link-hosts", "")),
      ),
    );
    var imageHosts = unique(
      [baseUrl.hostname.toLowerCase()].concat(
        scriptConfig.imageHosts,
        hostList(textAttribute(mount, "data-gnco-image-hosts", "")),
      ),
    );

    var requestedHeadingLevel = integerAttribute(mount, "data-gnco-heading-level", 3, 2, 6);

    return {
      type: mountType,
      stream: definition.stream,
      kind: definition.kind,
      endpoint: baseUrl.toString(),
      useStaticData: booleanAttribute(mount, "data-gnco-use-static-data", scriptConfig.useStaticData),
      limit: integerAttribute(mount, "data-gnco-limit", definition.limit, 1, 50),
      headingLevel: resolvedHeadingLevel(mountType, requestedHeadingLevel),
      showDescription: booleanAttribute(mount, "data-gnco-show-description", true),
      loadingText: textAttribute(mount, "data-gnco-loading-text", "Loading current information…"),
      emptyText: textAttribute(mount, "data-gnco-empty-text", "Nothing new is scheduled right now."),
      unavailableText: textAttribute(
        mount,
        "data-gnco-unavailable-text",
        "Current information is temporarily unavailable. Use the link below to view Church Center.",
      ),
      staleText: textAttribute(
        mount,
        "data-gnco-stale-text",
        "Showing the most recently available information.",
      ),
      linkLabel: textAttribute(mount, "data-gnco-link-label", ""),
      notesLabel: textAttribute(mount, "data-gnco-notes-label", "Message notes"),
      timeZone: textAttribute(mount, "data-gnco-time-zone", "America/Chicago"),
      linkHosts: linkHosts,
      imageHosts: imageHosts,
      timeout: integerAttribute(mount, "data-gnco-timeout", scriptConfig.timeout, 1000, 15000),
    };
  }

  function element(tagName, className, text) {
    var node = document.createElement(tagName);
    if (className) node.className = className;
    if (typeof text === "string") node.textContent = text;
    return node;
  }

  function ensureShell(mount) {
    var nativeFallback = Array.from(mount.children).find(function findFallback(child) {
      return child.hasAttribute("data-gnco-native");
    });

    if (!nativeFallback) {
      nativeFallback = element("div", "gnco-feed__native");
      nativeFallback.setAttribute("data-gnco-native", "");
      while (mount.firstChild) nativeFallback.appendChild(mount.firstChild);
      mount.appendChild(nativeFallback);
    } else {
      nativeFallback.classList.add("gnco-feed__native");
    }

    var status = element("p", "gnco-feed__status");
    status.setAttribute("data-gnco-generated", "status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    mount.appendChild(status);

    var output = element("div", "gnco-feed__output");
    output.setAttribute("data-gnco-generated", "output");
    output.hidden = true;
    mount.appendChild(output);

    return {
      mount: mount,
      nativeFallback: nativeFallback,
      nativeWasHidden: nativeFallback.hidden,
      status: status,
      output: output,
      hasRendered: false,
    };
  }

  function setState(shell, state, message) {
    shell.mount.setAttribute("data-gnco-state", state);
    shell.mount.setAttribute("aria-busy", state === "loading" ? "true" : "false");
    shell.status.textContent = message || "";

    if (state === "ready" || state === "stale") {
      shell.nativeFallback.hidden = true;
      shell.output.hidden = false;
      shell.hasRendered = true;
      return;
    }

    if (state === "empty" || state === "unavailable" || !shell.hasRendered) {
      shell.nativeFallback.hidden = shell.nativeWasHidden;
      shell.output.hidden = true;
    }
  }

  function debug(error) {
    if (scriptConfig.debug && window.console && typeof window.console.warn === "function") {
      window.console.warn("GNCO feed renderer:", error);
    }
  }

  function validEnvelope(value) {
    if (!value || typeof value !== "object") return false;
    if (value.schemaVersion !== 1) return false;
    if (!["live", "stale", "unavailable"].includes(value.status)) return false;
    if (!Array.isArray(value.records) || value.records.length > 100) return false;
    return true;
  }

  function staticEnvelope(config) {
    var payload = window.GNCOFeedStatic;
    if (!config.useStaticData || !payload || typeof payload !== "object") return null;
    if (payload.schemaVersion !== 1 || !payload.streams || typeof payload.streams !== "object") return null;
    var envelope = payload.streams[config.stream];
    return validEnvelope(envelope) ? envelope : null;
  }

  function effectiveStatus(envelope) {
    if (envelope.status === "unavailable") return "unavailable";
    var sourceFetchedAt = dateValue(envelope.sourceFetchedAt);
    var staleAfterSeconds = Number.parseInt(envelope.staleAfterSeconds, 10);
    if (
      sourceFetchedAt &&
      Number.isFinite(staleAfterSeconds) &&
      staleAfterSeconds > 0 &&
      Date.now() - sourceFetchedAt.getTime() > staleAfterSeconds * 1000
    ) {
      return "stale";
    }
    return envelope.status;
  }

  function requestEnvelope(config, force) {
    if (force) fetchCache.delete(config.endpoint);
    if (fetchCache.has(config.endpoint)) return fetchCache.get(config.endpoint);

    var embedded = staticEnvelope(config);
    if (embedded) {
      var staticRequest = Promise.resolve(embedded);
      fetchCache.set(config.endpoint, staticRequest);
      return staticRequest;
    }

    var request = new Promise(function performRequest(resolve, reject) {
      var controller = new AbortController();
      var timeout = window.setTimeout(function abortRequest() {
        controller.abort();
      }, config.timeout);

      fetch(config.endpoint, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "default",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      })
        .then(function readResponse(response) {
          if (!response.ok) throw new Error("GNCO feed request failed");
          var contentType = response.headers && response.headers.get
            ? response.headers.get("Content-Type") || ""
            : "application/json";
          if (contentType.toLowerCase().indexOf("application/json") === -1) {
            throw new Error("GNCO feed returned an unexpected content type");
          }
          return response.json();
        })
        .then(function validateResponse(payload) {
          if (!validEnvelope(payload)) throw new Error("GNCO feed returned an invalid payload");
          resolve(payload);
        })
        .catch(reject)
        .finally(function cleanupRequest() {
          window.clearTimeout(timeout);
        });
    });

    fetchCache.set(config.endpoint, request);
    request.catch(function removeFailedRequest() {
      if (fetchCache.get(config.endpoint) === request) fetchCache.delete(config.endpoint);
    });
    return request;
  }

  function plainText(value, maximum) {
    if (typeof value !== "string") return "";
    return value.replace(/\s+/g, " ").trim().slice(0, maximum);
  }

  function titleKey(value) {
    return plainText(value, 180).toLowerCase();
  }

  function isHomeSpotlightEvent(record) {
    var sourceTitle = titleKey(record && record.sourceTitle);
    var displayTitle = titleKey(record && record.displayTitle);
    var categoryTags = Array.isArray(record && record.categoryTags)
      ? record.categoryTags.map(titleKey)
      : [];

    if (
      HOME_EVENT_EXCLUDED_TITLES.includes(sourceTitle) ||
      HOME_EVENT_EXCLUDED_TITLES.includes(displayTitle)
    ) {
      return false;
    }

    return !categoryTags.some(function hasHomeExclusionTag(tag) {
      return HOME_EVENT_EXCLUDED_CATEGORY_TAGS.includes(tag);
    });
  }

  function sourceDescription(value, maximum) {
    if (typeof value !== "string") return "";
    try {
      var parsed = new DOMParser().parseFromString(value, "text/html");
      parsed.querySelectorAll("script,style,noscript,template,svg,math").forEach(function removeUnsafeNode(node) {
        node.remove();
      });
      parsed.querySelectorAll("br").forEach(function replaceBreak(node) {
        node.replaceWith(parsed.createTextNode(" "));
      });
      parsed.querySelectorAll("p,div,li,blockquote,h1,h2,h3,h4,h5,h6").forEach(function separateBlocks(node) {
        node.appendChild(parsed.createTextNode(" "));
      });
      return plainText(parsed.body.textContent || "", maximum);
    } catch (_error) {
      return plainText(value.replace(/<[^>]*>/g, " "), maximum);
    }
  }

  function safeRecordUrl(record, config) {
    return safeHttpsUrl(record && record.url, config.linkHosts);
  }

  function safeImage(record, config) {
    if (!record || !record.image || typeof record.image !== "object") return null;
    var url = safeHttpsUrl(record.image.url, config.imageHosts);
    if (!url) return null;
    return {
      url: url,
      alt: plainText(record.image.alt, 180) || plainText(record.displayTitle, 180),
    };
  }

  function dateValue(value) {
    if (typeof value !== "string") return null;
    var date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function formatter(options, timeZone) {
    try {
      return new Intl.DateTimeFormat("en-US", Object.assign({ timeZone: timeZone }, options));
    } catch (_error) {
      return new Intl.DateTimeFormat("en-US", Object.assign({ timeZone: "America/Chicago" }, options));
    }
  }

  function eventDateParts(record, timeZone) {
    var startsAt = dateValue(record.startsAt);
    if (!startsAt) return null;
    var dateLabel = formatter({ month: "short", day: "numeric", year: "numeric" }, timeZone).format(startsAt);
    var timeLabel = record.allDay
      ? "All day"
      : formatter({ hour: "numeric", minute: "2-digit" }, timeZone).format(startsAt);
    return { startsAt: startsAt, dateLabel: dateLabel, timeLabel: timeLabel };
  }

  function publishedDate(value, timeZone) {
    var date = dateValue(value);
    return date ? formatter({ month: "long", day: "numeric", year: "numeric" }, timeZone).format(date) : "";
  }

  function cardHeading(config, title, url) {
    var heading = element("h" + config.headingLevel, "gnco-feed-card__title");
    if (url) {
      var link = element("a", "gnco-feed-card__title-link", title);
      link.href = url;
      heading.appendChild(link);
    } else {
      heading.textContent = title;
    }
    return heading;
  }

  function cardImage(record, config) {
    var imageData = safeImage(record, config);
    if (!imageData) return null;
    var media = element("div", "gnco-feed-card__media");
    var image = document.createElement("img");
    image.className = "gnco-feed-card__image";
    image.src = imageData.url;
    image.alt = imageData.alt;
    image.loading = config.type === "latest-message" ? "eager" : "lazy";
    image.decoding = "async";
    image.addEventListener("error", function hideBrokenImage() {
      media.hidden = true;
    });
    media.appendChild(image);
    return media;
  }

  function actionLink(url, label, secondary) {
    if (!url) return null;
    var link = element(
      "a",
      secondary ? "gnco-feed-card__action gnco-feed-card__action--secondary" : "gnco-feed-card__action",
      label,
    );
    link.href = url;
    return link;
  }

  function eventCard(record, config) {
    var title = plainText(record.displayTitle, 180);
    var sourceId = plainText(record.sourceId, 120);
    var dateParts = eventDateParts(record, config.timeZone);
    if (record.kind !== "event" || !title || !sourceId || !dateParts) return null;

    var article = element("article", "gnco-feed-card gnco-feed-card--event");
    article.setAttribute("role", "listitem");
    var image = cardImage(record, config);
    if (image) article.appendChild(image);

    var body = element("div", "gnco-feed-card__body");
    var date = element("time", "gnco-feed-card__date", dateParts.dateLabel);
    date.dateTime = record.startsAt;
    body.appendChild(date);

    var url = safeRecordUrl(record, config);
    var registrationUrl = safeHttpsUrl(record.registrationUrl, config.linkHosts);
    body.appendChild(cardHeading(config, title, url));

    var metaParts = [dateParts.timeLabel, plainText(record.location, 180)].filter(Boolean);
    if (metaParts.length) body.appendChild(element("p", "gnco-feed-card__meta", metaParts.join(" · ")));

    var description = sourceDescription(record.description, 500);
    if (config.showDescription && description) {
      body.appendChild(element("p", "gnco-feed-card__description", description));
    }

    var action = actionLink(registrationUrl || url, config.linkLabel || "Details + RSVP", false);
    if (action) body.appendChild(action);
    article.appendChild(body);
    return article;
  }

  function messageCard(record, config) {
    var title = plainText(record.displayTitle, 180);
    var sourceId = plainText(record.sourceId, 120);
    var published = publishedDate(record.publishedAt, config.timeZone);
    if (record.kind !== "message" || !title || !sourceId || !published) return null;

    var article = element("article", "gnco-feed-card gnco-feed-card--message");
    article.setAttribute("role", "listitem");
    var image = cardImage(record, config);
    if (image) article.appendChild(image);

    var body = element("div", "gnco-feed-card__body");
    var eyebrow = config.type === "latest-message" ? "Latest message" : plainText(record.series && record.series.title, 120);
    if (eyebrow) body.appendChild(element("p", "gnco-feed-card__eyebrow", eyebrow));

    var url = safeRecordUrl(record, config);
    body.appendChild(cardHeading(config, title, url));

    var speakers = Array.isArray(record.speakers)
      ? record.speakers.map(function cleanSpeaker(value) { return plainText(value, 100); }).filter(Boolean).join(", ")
      : "";
    var meta = [speakers, published].filter(Boolean).join(" · ");
    if (meta) body.appendChild(element("p", "gnco-feed-card__meta", meta));

    var description = sourceDescription(record.excerpt || record.description, 500);
    if (config.showDescription && description) {
      body.appendChild(element("p", "gnco-feed-card__description", description));
    }

    var actions = element("div", "gnco-feed-card__actions");
    var primary = actionLink(url, config.linkLabel || "Watch message", false);
    var notes = actionLink(safeHttpsUrl(record.notesUrl, config.linkHosts), config.notesLabel, true);
    if (primary) actions.appendChild(primary);
    if (notes) actions.appendChild(notes);
    if (actions.childElementCount) body.appendChild(actions);

    article.appendChild(body);
    return article;
  }

  function seriesCard(record, config) {
    var title = plainText(record.displayTitle, 180);
    var sourceId = plainText(record.sourceId, 120);
    if (record.kind !== "series" || !title || !sourceId) return null;

    var article = element("article", "gnco-feed-card gnco-feed-card--series");
    article.setAttribute("role", "listitem");
    var image = cardImage(record, config);
    if (image) article.appendChild(image);

    var body = element("div", "gnco-feed-card__body");
    body.appendChild(element("p", "gnco-feed-card__eyebrow", "Message series"));
    var url = safeRecordUrl(record, config);
    body.appendChild(cardHeading(config, title, url));

    var description = sourceDescription(record.description, 500);
    if (config.showDescription && description) {
      body.appendChild(element("p", "gnco-feed-card__description", description));
    }
    var action = actionLink(url, config.linkLabel || "Explore series", false);
    if (action) body.appendChild(action);
    article.appendChild(body);
    return article;
  }

  function renderRecords(shell, records, config) {
    var grid = element("div", "gnco-feed__grid");
    grid.setAttribute("role", "list");
    var accepted = 0;

    var currentRecords = config.kind === "event"
      ? records.filter(function keepCurrentEvent(record) {
        if (!record || record.kind !== "event") return false;
        var cutoff = dateValue(record.endsAt || record.startsAt);
        return cutoff && cutoff.getTime() > Date.now();
      })
      : records;

    if (config.type === "home-events") {
      currentRecords = currentRecords
        .filter(isHomeSpotlightEvent)
        .sort(function sortHomeEvents(left, right) {
          return Date.parse(left.startsAt) - Date.parse(right.startsAt);
        });
    }

    currentRecords.slice(0, config.limit).forEach(function renderRecord(record) {
      if (!record || typeof record !== "object" || record.kind !== config.kind) return;
      var card = config.kind === "event"
        ? eventCard(record, config)
        : config.kind === "message"
          ? messageCard(record, config)
          : seriesCard(record, config);
      if (!card) return;
      grid.appendChild(card);
      accepted += 1;
    });

    if (!accepted) return 0;
    shell.output.replaceChildren(grid);
    return accepted;
  }

  function dispatch(shell, state, count) {
    shell.mount.dispatchEvent(
      new CustomEvent("gnco:feed-rendered", {
        bubbles: true,
        detail: { state: state, count: count, mountType: shell.mount.getAttribute("data-gnco-feed") },
      }),
    );
  }

  function renderMount(mount, force) {
    if (!(mount instanceof Element)) return Promise.resolve();
    var instance = mountInstances.get(mount);
    if (!instance) {
      instance = { shell: ensureShell(mount), config: null };
      mountInstances.set(mount, instance);
    }

    var config;
    try {
      config = mountConfig(mount);
      instance.config = config;
    } catch (error) {
      debug(error);
      setState(instance.shell, "unavailable", textAttribute(mount, "data-gnco-unavailable-text", "Current information is temporarily unavailable."));
      dispatch(instance.shell, "unavailable", 0);
      return Promise.resolve();
    }

    setState(instance.shell, "loading", config.loadingText);
    return requestEnvelope(config, Boolean(force))
      .then(function applyEnvelope(envelope) {
        var envelopeStatus = effectiveStatus(envelope);
        if (envelopeStatus === "unavailable") {
          setState(instance.shell, "unavailable", config.unavailableText);
          dispatch(instance.shell, "unavailable", 0);
          return;
        }
        var renderedCount = renderRecords(instance.shell, envelope.records, config);
        if (!renderedCount) {
          setState(instance.shell, "empty", config.emptyText);
          dispatch(instance.shell, "empty", 0);
          return;
        }
        var state = envelopeStatus === "stale" ? "stale" : "ready";
        setState(instance.shell, state, state === "stale" ? config.staleText : "Current information loaded.");
        dispatch(instance.shell, state, renderedCount);
      })
      .catch(function handleFailure(error) {
        debug(error);
        setState(instance.shell, "unavailable", config.unavailableText);
        dispatch(instance.shell, "unavailable", 0);
      });
  }

  function mountsWithin(root) {
    var mounts = [];
    if (root instanceof Element && root.matches(MOUNT_SELECTOR)) mounts.push(root);
    if (root && typeof root.querySelectorAll === "function") {
      mounts = mounts.concat(Array.from(root.querySelectorAll(MOUNT_SELECTOR)));
    }
    return unique(mounts);
  }

  function mountAll(root) {
    return Promise.all(mountsWithin(root || document).map(function mountOne(mount) {
      return renderMount(mount, false);
    }));
  }

  function refresh(target) {
    var mounts = target ? mountsWithin(target) : Array.from(mountInstances.keys());
    return Promise.all(mounts.map(function refreshOne(mount) {
      return renderMount(mount, true);
    }));
  }

  function installStyles() {
    if (document.getElementById("gnco-feed-renderer-styles")) return;
    var style = document.createElement("style");
    style.id = "gnco-feed-renderer-styles";
    style.textContent = [
      "[data-gnco-feed]{--gnco-feed-ink:#242321;--gnco-feed-paper:#f7f3eb;--gnco-feed-accent:#bf6f1e;--gnco-feed-line:rgba(36,35,33,.18);color:var(--gnco-feed-ink);font-family:\"DM Sans\",var(--body-font-font-family),sans-serif}",
      "[data-gnco-feed][aria-busy=\"true\"]{cursor:progress}",
      ".gnco-feed__status{margin:.75rem 0;color:inherit;font:600 .9rem/1.5 \"DM Sans\",var(--body-font-font-family),sans-serif}",
      "[data-gnco-state=\"ready\"]>.gnco-feed__status{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}",
      ".gnco-feed__grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,17rem),1fr));gap:clamp(1rem,2vw,1.75rem)}",
      ".gnco-feed-card{min-width:0;background:var(--gnco-feed-paper);border-top:5px solid var(--gnco-feed-ink);display:flex;flex-direction:column}",
      ".gnco-feed-card__media{aspect-ratio:16/9;background:#ded8ce;overflow:hidden}",
      ".gnco-feed-card__image{display:block;width:100%;height:100%;object-fit:cover;transition:transform .35s ease}",
      ".gnco-feed-card:hover .gnco-feed-card__image{transform:scale(1.025)}",
      ".gnco-feed-card__body{display:flex;flex:1;flex-direction:column;align-items:flex-start;padding:clamp(1rem,2.4vw,1.5rem)}",
      ".gnco-feed-card__eyebrow,.gnco-feed-card__date{margin:0 0 .55rem;color:var(--gnco-feed-accent);font:800 .76rem/1.2 \"DM Sans\",var(--body-font-font-family),sans-serif;letter-spacing:.1em;text-transform:uppercase}",
      ".gnco-feed-card__title{margin:0;font-family:\"Archivo Black\",var(--heading-font-font-family),sans-serif;font-size:clamp(1.45rem,2.5vw,2.15rem);font-weight:400;letter-spacing:-.035em;line-height:.98;text-transform:uppercase}",
      ".gnco-feed-card__title-link{color:inherit;text-decoration:none}",
      ".gnco-feed-card__title-link:hover{text-decoration:underline;text-decoration-color:var(--gnco-feed-accent);text-decoration-thickness:.13em;text-underline-offset:.13em}",
      ".gnco-feed-card__meta{margin:.8rem 0 0;font-size:.94rem;font-weight:700;line-height:1.45}",
      ".gnco-feed-card__description{margin:.75rem 0 0;font-size:1rem;line-height:1.55}",
      ".gnco-feed-card__actions{display:flex;flex-wrap:wrap;gap:.65rem;margin-top:auto;padding-top:1.2rem}",
      ".gnco-feed-card__action{display:inline-flex;align-items:center;justify-content:center;margin-top:auto;padding:.78rem 1rem;background:var(--gnco-feed-accent);color:#fff;font-size:.78rem;font-weight:800;letter-spacing:.055em;line-height:1.1;text-decoration:none;text-transform:uppercase}",
      ".gnco-feed-card__description+.gnco-feed-card__action,.gnco-feed-card__meta+.gnco-feed-card__action,.gnco-feed-card__title+.gnco-feed-card__action{margin-top:1.2rem}",
      ".gnco-feed-card__action--secondary{background:transparent;box-shadow:inset 0 0 0 2px var(--gnco-feed-ink);color:var(--gnco-feed-ink)}",
      ".gnco-feed-card__action:hover{filter:brightness(.92)}",
      ".gnco-feed-card a:focus-visible{outline:3px solid var(--gnco-feed-ink);outline-offset:4px}",
      "[data-gnco-feed=\"latest-message\"] .gnco-feed__grid{grid-template-columns:1fr}",
      "[data-gnco-feed=\"latest-message\"] .gnco-feed-card{border-top-width:7px}",
      "@media(min-width:52rem){[data-gnco-feed=\"latest-message\"] .gnco-feed-card{display:grid;grid-template-columns:minmax(0,1.18fr) minmax(18rem,.82fr)}[data-gnco-feed=\"latest-message\"] .gnco-feed-card__media{height:100%;min-height:24rem;aspect-ratio:auto}[data-gnco-feed=\"latest-message\"] .gnco-feed-card__body{padding:clamp(1.5rem,4vw,3.25rem)}}",
      "@media(prefers-reduced-motion:reduce){.gnco-feed-card__image{transition:none}.gnco-feed-card:hover .gnco-feed-card__image{transform:none}}",
      "@media(forced-colors:active){.gnco-feed-card{border:2px solid CanvasText}.gnco-feed-card__action{border:2px solid LinkText}}",
    ].join("");
    document.head.appendChild(style);
  }

  installStyles();

  window.GNCOFeeds = {
    version: VERSION,
    mount: function mount(elementToMount) { return renderMount(elementToMount, false); },
    mountAll: mountAll,
    refresh: refresh,
  };

  function start() {
    mountAll();
    if (typeof MutationObserver === "function") {
      var observer = new MutationObserver(function observeMounts(mutations) {
        mutations.forEach(function inspectMutation(mutation) {
          mutation.addedNodes.forEach(function inspectNode(node) {
            if (node.nodeType === 1) mountAll(node);
          });
        });
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
