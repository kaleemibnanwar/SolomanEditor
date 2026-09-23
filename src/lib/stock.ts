/**
 * Live stock search.
 *
 *   • Wikimedia    — Commons media, freely licensed, key-less (commons.wikimedia.org)
 *   • The Met      — Open Access public-domain art, key-less (collectionapi.metmuseum.org)
 *   • Pixabay      — photos, illustrations & video, needs a free key
 *   • Pexels       — photos & video, needs a free key
 *
 * Everything is additive: the bundled library in `@/lib/library` always works
 * offline, this just widens the net when the browser is online. Keyed sources
 * read their key via `@/lib/settings` and simply report "add a key" when it's
 * missing, rather than failing silently.
 *
 * Downloads are fetched to a Blob and turned into a real File so they flow
 * through the normal import path (`importFiles`) — the encoder needs a
 * same-origin object URL or the canvas gets tainted.
 */
import { toast } from "sonner";
import { importFiles, type ImportOptions } from "@/lib/importFiles";
import { getSetting, type SettingKey } from "@/lib/settings";

export type StockSource = "wikimedia" | "met" | "pixabay" | "pexels";
export type StockKind = "image" | "audio" | "video";

export interface StockItem {
  id: string;
  source: StockSource;
  kind: StockKind;
  title: string;
  creator?: string;
  license: string;
  licenseUrl?: string;
  /** human page to credit the work */
  pageUrl?: string;
  /** small grid thumbnail */
  thumbUrl: string;
  /** full-resolution file used on download */
  fullUrl: string;
  width?: number;
  height?: number;
  duration?: number;
  provider?: string;
}

export interface StockQuery {
  text: string;
  source: StockSource;
  kind: StockKind;
  limit?: number;
  signal?: AbortSignal;
}

export interface StockSourceInfo {
  id: StockSource;
  label: string;
  blurb: string;
  kinds: StockKind[];
  home: string;
}

export const STOCK_SOURCES: StockSourceInfo[] = [
  {
    id: "wikimedia",
    label: "Wikimedia",
    blurb: "Commons media, freely licensed",
    kinds: ["image", "audio", "video"],
    home: "https://commons.wikimedia.org",
  },
  {
    id: "met",
    label: "The Met",
    blurb: "Public-domain art & artefacts",
    kinds: ["image"],
    home: "https://www.metmuseum.org/art/collection",
  },
  {
    id: "pixabay",
    label: "Pixabay",
    blurb: "Photos, illustrations & video — needs a key",
    kinds: ["image", "video"],
    home: "https://pixabay.com",
  },
  {
    id: "pexels",
    label: "Pexels",
    blurb: "Photos & video — needs a key",
    kinds: ["image", "video"],
    home: "https://www.pexels.com",
  },
];

export function stockSourcesFor(kind: StockKind): StockSourceInfo[] {
  return STOCK_SOURCES.filter((s) => s.kinds.includes(kind));
}

/* ------------------------------------------------------------------ *
 * Fetch plumbing
 * ------------------------------------------------------------------ */

const TIMEOUT_MS = 12_000;
const CACHE_LIMIT = 80;

const cache = new Map<string, StockItem[]>();

/**
 * A failure the user can actually do something about on their own. Right now
 * that is only a keyed source with nothing configured: it is the one search
 * error where sending them to Settings is the fix, as opposed to a retry.
 */
export type StockErrorCode = "missing-key";

class StockError extends Error {
  constructor(message: string, readonly friendly: string, readonly code?: StockErrorCode) {
    super(message);
  }
}

export function stockErrorCode(err: unknown): StockErrorCode | undefined {
  return err instanceof StockError ? err.code : undefined;
}

/**
 * @param keyed Whether this request carries an API key — only then does a
 *   401/403 get blamed on the key. A key-less source (Wikimedia, The Met) can
 *   still be refused by a host's own bot-detection or a transient block, and
 *   "check your key in Settings" would be actively misleading there since it
 *   has none.
 */
async function requestJson<T>(
  url: string,
  signal?: AbortSignal,
  headers?: Record<string, string>,
  keyed = false,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const relay = () => ctrl.abort();
  signal?.addEventListener("abort", relay);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json", ...headers } });
    if (!res.ok) {
      const friendly =
        res.status === 429
          ? "Rate limit reached — try again in a moment or switch source."
          : keyed && (res.status === 401 || res.status === 403)
            ? "That key was rejected — check it in Settings."
            : `The source replied with ${res.status}.`;
      throw new StockError(`HTTP ${res.status} for ${url}`, friendly);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof StockError) throw err;
    if ((err as Error)?.name === "AbortError") throw err;
    throw new StockError(String(err), "Couldn't reach that source — check your connection.");
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener("abort", relay);
  }
}

/** A keyed source with nothing configured in Settings yet. */
function requireKey(value: string | null, label: string): string {
  if (!value) {
    throw new StockError(
      `no ${label} key configured`,
      `Add a ${label} key in Settings to use this source.`,
      "missing-key",
    );
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * Checking a key
 * ------------------------------------------------------------------ */

export type StockKeyStatus = "valid" | "invalid" | "unknown";

export interface StockKeyVerdict {
  status: StockKeyStatus;
  message: string;
}

/** How to ask a provider whether it recognises a key. */
interface KeyProbe {
  url: string;
  headers?: Record<string, string>;
}

/**
 * The cheapest request each provider will answer, used only to find out
 * whether the key is recognised.
 */
function keyProbe(key: SettingKey, value: string): KeyProbe {
  switch (key) {
    case "pixabayApiKey":
      return {
        url: `https://pixabay.com/api/?${new URLSearchParams({ key: value, q: "test", per_page: "3" })}`,
      };
    case "pexelsApiKey":
      return {
        url: `https://api.pexels.com/v1/search?${new URLSearchParams({ query: "test", per_page: "1" })}`,
        headers: { Authorization: value },
      };
  }
}

const KEY_PROBE_TIMEOUT_MS = 8_000;

/**
 * Ask the provider whether it recognises this key, so a typo surfaces while
 * the field is being edited rather than as a failed search later.
 *
 * Only a refusal is called invalid. A timeout, a rate limit or a provider
 * that is simply unreachable reports "unknown" — a key that could not be
 * checked is not the same as a key that was checked and rejected, and
 * treating the two alike would block a perfectly good key.
 */
export async function validateStockKey(key: SettingKey, value: string): Promise<StockKeyVerdict> {
  const trimmed = value.trim();
  if (!trimmed) return { status: "unknown", message: "" };

  const probe = keyProbe(key, trimmed);

  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), KEY_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(probe.url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json", ...probe.headers },
    });
    if (res.ok) return { status: "valid", message: "Key verified." };
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return { status: "invalid", message: `That key was rejected (${res.status}) — check it against your account.` };
    }
    if (res.status === 429) {
      return { status: "unknown", message: "The provider is rate limiting right now, so the key wasn't checked." };
    }
    return { status: "unknown", message: `The provider replied with ${res.status}, so the key wasn't checked.` };
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      return { status: "unknown", message: "Checking the key took too long — it wasn't verified." };
    }
    return { status: "unknown", message: "Couldn't reach the provider — the key wasn't verified." };
  } finally {
    window.clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extFromUrl(url: string): string {
  const path = url.split("?")[0];
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return /^[a-z0-9]{2,5}$/.test(ext) ? ext : "";
}

function extForKind(kind: StockKind, url: string): string {
  const found = extFromUrl(url);
  if (found) return found;
  if (kind === "image") return "jpg";
  if (kind === "audio") return "mp3";
  return "webm";
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function kindFromMime(mime: string): StockKind | null {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return null;
}

/* ------------------------------------------------------------------ *
 * Wikimedia Commons
 * ------------------------------------------------------------------ */

interface CommonsPage {
  pageid: number;
  title: string;
  imageinfo?: {
    url?: string;
    thumburl?: string;
    descriptionurl?: string;
    width?: number;
    height?: number;
    mime?: string;
    extmetadata?: Record<string, { value?: string }>;
  }[];
}

interface CommonsResponse {
  query?: { pages?: Record<string, CommonsPage> };
}

async function searchWikimedia(
  text: string,
  kind: StockKind,
  limit: number,
  signal?: AbortSignal,
): Promise<StockItem[]> {
  const typeFilter = kind === "audio" ? "filetype:audio" : kind === "video" ? "filetype:video" : "filetype:bitmap";
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    origin: "*",
    generator: "search",
    gsrsearch: `${typeFilter} ${text}`.trim(),
    gsrnamespace: "6",
    gsrlimit: String(Math.max(1, Math.min(40, limit))),
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiurlwidth: "480",
  });
  const data = await requestJson<CommonsResponse>(
    `https://commons.wikimedia.org/w/api.php?${params.toString()}`,
    signal,
  );

  const pages = Object.values(data.query?.pages ?? {});
  const out: StockItem[] = [];

  for (const page of pages) {
    const info = page.imageinfo?.[0];
    if (!info?.url) continue;
    const meta = info.extmetadata ?? {};
    const pageKind = info.mime ? kindFromMime(info.mime) : null;
    if (!pageKind) continue;
    out.push({
      id: `wikimedia:${page.pageid}`,
      source: "wikimedia",
      kind: pageKind,
      title: stripHtml(page.title.replace(/^File:/, "").replace(/\.[^.]+$/, "")) || "Commons file",
      creator: meta.Artist?.value ? stripHtml(meta.Artist.value) || undefined : undefined,
      license: meta.LicenseShortName?.value ? stripHtml(meta.LicenseShortName.value) : "See source",
      licenseUrl: meta.LicenseUrl?.value,
      pageUrl: info.descriptionurl,
      thumbUrl: info.thumburl || info.url,
      fullUrl: info.url,
      width: info.width,
      height: info.height,
      provider: "Wikimedia Commons",
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The Met — Open Access
 * ------------------------------------------------------------------ */

interface MetSearch {
  total?: number;
  objectIDs?: number[] | null;
}

interface MetObject {
  objectID: number;
  title?: string;
  artistDisplayName?: string;
  primaryImage?: string;
  primaryImageSmall?: string;
  isPublicDomain?: boolean;
  objectDate?: string;
  objectURL?: string;
  department?: string;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    out.push(...(await Promise.all(chunk.map(fn))));
  }
  return out;
}

async function searchMet(text: string, limit: number, signal?: AbortSignal): Promise<StockItem[]> {
  const params = new URLSearchParams({ hasImages: "true", q: text });
  const found = await requestJson<MetSearch>(
    `https://collectionapi.metmuseum.org/public/collection/v1/search?${params.toString()}`,
    signal,
  );

  const ids = (found.objectIDs ?? []).slice(0, limit + 8);
  if (!ids.length) return [];

  const objects = await mapLimit(ids, 6, async (id) => {
    try {
      return await requestJson<MetObject>(
        `https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`,
        signal,
      );
    } catch {
      return null;
    }
  });

  return objects
    .filter((obj): obj is MetObject => Boolean(obj?.primaryImage && obj.title))
    .slice(0, limit)
    .map<StockItem>((obj) => ({
      id: `met:${obj.objectID}`,
      source: "met",
      kind: "image",
      title: obj.title!,
      creator: obj.artistDisplayName || undefined,
      license: obj.isPublicDomain ? "CC0 · Public Domain" : "Met Open Access",
      licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
      pageUrl: obj.objectURL,
      thumbUrl: obj.primaryImageSmall || obj.primaryImage!,
      fullUrl: obj.primaryImage!,
      provider: obj.department ? `The Met · ${obj.department}` : "The Met",
    }));
}

/* ------------------------------------------------------------------ *
 * Pixabay
 * ------------------------------------------------------------------ */

interface PixabayImageHit {
  id: number;
  tags?: string;
  user?: string;
  pageURL?: string;
  previewURL?: string;
  webformatURL?: string;
  largeImageURL?: string;
  imageWidth?: number;
  imageHeight?: number;
}

interface PixabayVideoHit {
  id: number;
  tags?: string;
  user?: string;
  pageURL?: string;
  duration?: number;
  videos?: Record<string, { url: string; width: number; height: number; thumbnail?: string }>;
}

const PIXABAY_LICENSE = "Pixabay License";
const PIXABAY_LICENSE_URL = "https://pixabay.com/service/license/";

async function searchPixabay(text: string, kind: StockKind, limit: number, signal?: AbortSignal): Promise<StockItem[]> {
  const key = requireKey(await getSetting("pixabayApiKey"), "Pixabay");
  const perPage = String(Math.max(3, Math.min(200, limit)));

  if (kind === "video") {
    const params = new URLSearchParams({ key, q: text, per_page: perPage, safesearch: "true" });
    const data = await requestJson<{ hits?: PixabayVideoHit[] }>(
      `https://pixabay.com/api/videos/?${params.toString()}`,
      signal,
      undefined,
      true,
    );
    return (data.hits ?? [])
      .map((hit) => {
        const variant = hit.videos?.medium ?? hit.videos?.large ?? hit.videos?.small ?? hit.videos?.tiny;
        if (!variant?.url) return null;
        const item: StockItem = {
          id: `pixabay:${hit.id}`,
          source: "pixabay",
          kind: "video",
          title: hit.tags?.split(",")[0]?.trim() || "Pixabay video",
          creator: hit.user,
          license: PIXABAY_LICENSE,
          licenseUrl: PIXABAY_LICENSE_URL,
          pageUrl: hit.pageURL,
          thumbUrl: variant.thumbnail || hit.videos?.tiny?.url || variant.url,
          fullUrl: variant.url,
          width: variant.width,
          height: variant.height,
          duration: hit.duration,
          provider: "Pixabay",
        };
        return item;
      })
      .filter((item): item is StockItem => item !== null);
  }

  const params = new URLSearchParams({ key, q: text, per_page: perPage, safesearch: "true", image_type: "all" });
  const data = await requestJson<{ hits?: PixabayImageHit[] }>(
    `https://pixabay.com/api/?${params.toString()}`,
    signal,
    undefined,
    true,
  );
  return (data.hits ?? [])
    .filter((hit) => Boolean(hit.largeImageURL || hit.webformatURL))
    .map<StockItem>((hit) => ({
      id: `pixabay:${hit.id}`,
      source: "pixabay",
      kind: "image",
      title: hit.tags?.split(",")[0]?.trim() || "Pixabay image",
      creator: hit.user,
      license: PIXABAY_LICENSE,
      licenseUrl: PIXABAY_LICENSE_URL,
      pageUrl: hit.pageURL,
      thumbUrl: hit.previewURL || hit.webformatURL || hit.largeImageURL!,
      fullUrl: hit.largeImageURL || hit.webformatURL!,
      width: hit.imageWidth,
      height: hit.imageHeight,
      provider: "Pixabay",
    }));
}

/* ------------------------------------------------------------------ *
 * Pexels
 * ------------------------------------------------------------------ */

interface PexelsPhoto {
  id: number;
  photographer?: string;
  url?: string;
  width?: number;
  height?: number;
  alt?: string;
  src?: { original?: string; large2x?: string; large?: string; medium?: string; small?: string };
}

interface PexelsVideoFile {
  link: string;
  width?: number;
  height?: number;
  quality?: string;
  file_type?: string;
}

interface PexelsVideo {
  id: number;
  url?: string;
  duration?: number;
  width?: number;
  height?: number;
  image?: string;
  user?: { name?: string };
  video_files?: PexelsVideoFile[];
}

const PEXELS_LICENSE = "Pexels License";
const PEXELS_LICENSE_URL = "https://www.pexels.com/license/";

async function searchPexels(text: string, kind: StockKind, limit: number, signal?: AbortSignal): Promise<StockItem[]> {
  const key = requireKey(await getSetting("pexelsApiKey"), "Pexels");
  const perPage = String(Math.max(1, Math.min(80, limit)));
  const headers = { Authorization: key };

  if (kind === "video") {
    const params = new URLSearchParams({ query: text, per_page: perPage });
    const data = await requestJson<{ videos?: PexelsVideo[] }>(
      `https://api.pexels.com/videos/search?${params.toString()}`,
      signal,
      headers,
      true,
    );
    return (data.videos ?? [])
      .map((video) => {
        const files = (video.video_files ?? []).filter((f) => f.link);
        const best =
          files.find((f) => f.quality === "hd") ?? files.find((f) => f.quality === "sd") ?? files[0];
        if (!best) return null;
        const item: StockItem = {
          id: `pexels:${video.id}`,
          source: "pexels",
          kind: "video",
          title: "Pexels video",
          creator: video.user?.name,
          license: PEXELS_LICENSE,
          licenseUrl: PEXELS_LICENSE_URL,
          pageUrl: video.url,
          thumbUrl: video.image || best.link,
          fullUrl: best.link,
          width: best.width ?? video.width,
          height: best.height ?? video.height,
          duration: video.duration,
          provider: "Pexels",
        };
        return item;
      })
      .filter((item): item is StockItem => item !== null);
  }

  const params = new URLSearchParams({ query: text, per_page: perPage });
  const data = await requestJson<{ photos?: PexelsPhoto[] }>(
    `https://api.pexels.com/v1/search?${params.toString()}`,
    signal,
    headers,
    true,
  );
  return (data.photos ?? [])
    .filter((photo) => Boolean(photo.src?.original || photo.src?.large))
    .map<StockItem>((photo) => ({
      id: `pexels:${photo.id}`,
      source: "pexels",
      kind: "image",
      title: photo.alt?.trim() || "Pexels photo",
      creator: photo.photographer,
      license: PEXELS_LICENSE,
      licenseUrl: PEXELS_LICENSE_URL,
      pageUrl: photo.url,
      thumbUrl: photo.src?.medium || photo.src?.small || photo.src?.large || photo.src?.original || "",
      fullUrl: photo.src?.original || photo.src?.large2x || photo.src?.large || "",
      width: photo.width,
      height: photo.height,
      provider: "Pexels",
    }));
}

/* ------------------------------------------------------------------ *
 * Public search
 * ------------------------------------------------------------------ */

export async function searchStock(query: StockQuery): Promise<StockItem[]> {
  const text = query.text.trim();
  if (!text) return [];
  const limit = query.limit ?? 24;

  const key = `${query.source}|${query.kind}|${limit}|${text.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let items: StockItem[];
  switch (query.source) {
    case "wikimedia":
      items = await searchWikimedia(text, query.kind, limit, query.signal);
      break;
    case "met":
      items = await searchMet(text, limit, query.signal);
      break;
    case "pixabay":
      items = await searchPixabay(text, query.kind, limit, query.signal);
      break;
    case "pexels":
      items = await searchPexels(text, query.kind, limit, query.signal);
      break;
  }

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, items);
  return items;
}

/** Known unsupported combinations never hit the network. */
export function stockSourceSupports(source: StockSource, kind: StockKind): boolean {
  const info = STOCK_SOURCES.find((s) => s.id === source);
  return Boolean(info?.kinds.includes(kind));
}

/* ------------------------------------------------------------------ *
 * Download → File → import
 * ------------------------------------------------------------------ */

export async function fetchStockFile(item: StockItem, signal?: AbortSignal): Promise<File> {
  let res: Response;
  try {
    res = await fetch(item.fullUrl, { signal });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    throw new StockError(
      String(err),
      `Couldn't download "${item.fullUrl}" — make sure it's a direct link to the file, not a webpage, and that the host allows cross-origin requests.`,
    );
  }
  if (!res.ok) {
    throw new StockError(`HTTP ${res.status} for ${item.fullUrl}`, `Download failed (${res.status}) for "${item.fullUrl}".`);
  }
  const blob = await res.blob();
  const ext = extForKind(item.kind, item.fullUrl);
  const type = blob.type || `${item.kind}/${ext}`;
  return new File([blob], `${slugify(item.title) || item.kind}.${ext}`, { type });
}

/** Same shape as `describeStockError`, phrased for a download rather than a search. */
export function describeDownloadError(err: unknown): string {
  if (err instanceof StockError) return err.friendly;
  if ((err as Error)?.name === "AbortError") return "Download cancelled.";
  return (err as Error)?.message || "The file could not be downloaded.";
}

/**
 * Fetches a stock item and runs it through the standard import path, so it
 * picks up thumbnails, waveforms and metadata exactly like a local file.
 */
export async function importStock(item: StockItem, options: ImportOptions = {}): Promise<boolean> {
  const toastId = toast.loading(`Downloading “${item.title}”…`);
  try {
    const file = await fetchStockFile(item);
    toast.dismiss(toastId);
    const added = await importFiles([file], { ...options, silent: true });
    if (!added) {
      toast.error("That file type isn't supported here");
      return false;
    }
    if (!options.silent) {
      toast.success(`Added ${item.title}`, {
        description: `${item.license} · ${sourceLabel(item.source)}`,
      });
    }
    return true;
  } catch (err) {
    toast.dismiss(toastId);
    toast.error("Download failed", { description: describeDownloadError(err) });
    return false;
  }
}

export function sourceLabel(source: StockSource): string {
  return STOCK_SOURCES.find((s) => s.id === source)?.label ?? source;
}

export function describeStockError(err: unknown): string {
  if (err instanceof StockError) return err.friendly;
  if ((err as Error)?.name === "AbortError") return "Search cancelled.";
  return "Something went wrong while searching.";
}
