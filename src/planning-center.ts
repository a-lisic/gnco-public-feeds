import type { Env, JsonApiDocument } from "./types";
import { errorMessage } from "./util";

const CHURCH_CENTER_ORIGIN = "https://goodnewsco.churchcenter.com";
const API_ORIGIN = "https://api.churchcenter.com";
const DEFAULT_CHANNEL_ID = "25787";
const DEFAULT_USER_AGENT = "GNCO Church Center Feed (https://goodnewsco.church)";
const REQUEST_TIMEOUT_MS = 6_000;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(response: Response | null): number {
  const retryAfter = response?.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1_000, 2_000);
  }
  return 350;
}

export class ChurchCenterClient {
  private readonly token: Promise<string>;
  private readonly userAgent: string;
  readonly channelId: string;

  constructor(env: Env) {
    this.userAgent = env.CC_USER_AGENT || DEFAULT_USER_AGENT;
    this.channelId = env.CHANNEL_ID || DEFAULT_CHANNEL_ID;
    this.token = this.getToken();
  }

  events(): Promise<JsonApiDocument> {
    return this.get(
      "/calendar/v2/events?include=location,event_registration_url,category_tags,campus_tags&filter=upcoming,first_occurrence&order=-featured,visible_starts_at&per_page=24",
    );
  }

  messages(): Promise<JsonApiDocument> {
    const channelId = encodeURIComponent(this.channelId);
    return this.get(
      `/publishing/v2/episodes?where%5Bchannel_id%5D=${channelId}&filter=published_to_library&order=-published_to_library_at&include=speakerships.speaker,series&per_page=12`,
    );
  }

  featuredSeries(): Promise<JsonApiDocument> {
    return this.get(`/publishing/v2/channels/${encodeURIComponent(this.channelId)}?include=featured_series`);
  }

  private async getToken(): Promise<string> {
    let lastError: unknown = new Error("Church Center session token request failed");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort("Church Center token request timed out"), REQUEST_TIMEOUT_MS);
      let response: Response | null = null;

      try {
        response = await fetch(`${CHURCH_CENTER_ORIGIN}/sessions/tokens`, {
          method: "POST",
          headers: { Accept: "application/json", "User-Agent": this.userAgent },
          signal: controller.signal,
        });
        if (response.ok) {
          const payload = (await response.json()) as {
            data?: { attributes?: { token?: unknown } };
          };
          const token = payload.data?.attributes?.token;
          if (typeof token !== "string" || !token) throw new Error("Church Center returned no session token");
          return token;
        }

        const retryable = response.status === 429 || response.status >= 500;
        lastError = new Error(`Church Center token request returned ${response.status}`);
        if (!retryable || attempt === 1) break;
      } catch (error) {
        lastError = error;
        if (attempt === 1) break;
      } finally {
        clearTimeout(timeout);
      }

      await sleep(retryDelay(response));
    }

    throw new Error(errorMessage(lastError));
  }

  private async get(path: string): Promise<JsonApiDocument> {
    let lastError: unknown = new Error("Planning Center request failed");
    const token = await this.token;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort("Planning Center request timed out"), REQUEST_TIMEOUT_MS);
      let response: Response | null = null;

      try {
        response = await fetch(`${API_ORIGIN}${path}`, {
          headers: {
            Accept: "application/vnd.api+json, application/json",
            Authorization: `Bearer ${token}`,
            "User-Agent": this.userAgent,
          },
          signal: controller.signal,
        });

        if (response.ok) {
          const payload = (await response.json()) as unknown;
          if (!payload || typeof payload !== "object") {
            throw new Error("Planning Center returned a non-object JSON document");
          }
          return payload as JsonApiDocument;
        }

        const retryable = response.status === 429 || response.status >= 500;
        const responseText = (await response.text()).slice(0, 240);
        lastError = new Error(
          `Church Center API ${response.status} for ${path}${responseText ? `: ${responseText}` : ""}`,
        );
        if (!retryable || attempt === 1) break;
      } catch (error) {
        lastError = error;
        if (attempt === 1) break;
      } finally {
        clearTimeout(timeout);
      }

      await sleep(retryDelay(response));
    }

    throw new Error(errorMessage(lastError));
  }
}
