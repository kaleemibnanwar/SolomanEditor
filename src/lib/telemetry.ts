/**
 * Usage telemetry via Microsoft Clarity.
 *
 * On by default (opt-out): the user can turn it off in Settings, which persists
 * the `telemetryEnabled` preference and stops Clarity from sending anything for
 * the rest of the session. If it was already off at boot, Clarity is never even
 * loaded — so an opted-out user's first paint never talks to clarity.ms.
 *
 * The tracking script loads from `https://www.clarity.ms`, which needs network
 * access from the renderer — already true, since the editor fetches stock-media
 * APIs directly. Only a first-party `event` and `identify` are exposed here;
 * nothing else about the project leaves the machine.
 */
import Clarity from "@microsoft/clarity";
import { getSetting, setSetting } from "@/lib/settings";

const CLARITY_PROJECT_ID = "yq5drd7m8z";

/** Whether the clarity script has actually been injected this session. */
let loaded = false;
/** Whether collection is currently allowed (mirrors the persisted preference). */
let enabled = false;

function ensureLoaded() {
  if (loaded || typeof window === "undefined") return;
  try {
    Clarity.init(CLARITY_PROJECT_ID);
    loaded = true;
  } catch (error) {
    console.warn("[octo-cut] Clarity could not start", error);
  }
}

/**
 * Read the opt-out preference and start Clarity if the user has not disabled it.
 * Called once, from `src/main.tsx`, before anything else runs.
 */
export async function initTelemetry(): Promise<void> {
  if (typeof window === "undefined") return;
  enabled = (await getSetting("telemetryEnabled")) !== "0";
  if (enabled) ensureLoaded();
}

/**
 * Flip the opt-out live. Enabling loads the script on first use; disabling
 * revokes consent for the rest of the session. A reload honours the persisted
 * value, so a disabled user is never initialised again.
 */
export async function setTelemetryEnabled(next: boolean): Promise<void> {
  await setSetting("telemetryEnabled", next ? "1" : "0");
  enabled = next;
  if (next) {
    ensureLoaded();
    if (loaded) {
      try {
        Clarity.consent(true);
      } catch {
        /* the script may not have finished loading yet; default consent is granted */
      }
    }
  } else if (loaded) {
    try {
      Clarity.consent(false);
    } catch {
      /* clarity not ready; the preference is what matters */
    }
  }
}

/** Send a first-party custom event. Dropped silently when telemetry is off. */
export function trackTelemetry(name: string): void {
  if (!enabled || !loaded || typeof window === "undefined") return;
  try {
    Clarity.event(name);
  } catch {
    /* telemetry must never break the editor */
  }
}

/** Associate an anonymous id with this session. Dropped silently when off. */
export function identifyTelemetry(id: string): void {
  if (!enabled || !loaded || typeof window === "undefined") return;
  try {
    Clarity.identify(id);
  } catch {
    /* telemetry must never break the editor */
  }
}
