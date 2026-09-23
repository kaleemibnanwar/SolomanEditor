/**
 * API keys for the keyed stock-media providers.
 *
 * Persisted through `src/lib/settings.ts` — on disk via the desktop app's
 * narrow settings IPC channel, or `localStorage` in a plain browser tab. Never
 * sent anywhere but the provider's own API: `src/lib/stock.ts` reads these
 * directly to build its own search requests, the same way it already talks to
 * the key-less sources.
 *
 * A pasted key is checked against its provider as it settles (and again on
 * save), so a typo surfaces here rather than later as a search that quietly
 * returns nothing. Only a refusal blocks saving: a key that merely couldn't be
 * reached is reported as unverified and left alone.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, HelpCircle, Info, KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { getAllSettings, setSetting, settingsPersist, type SettingKey } from "@/lib/settings";
import { validateStockKey, type StockKeyStatus, type StockKeyVerdict } from "@/lib/stock";

const inputClass =
  "h-7 rounded border-km-border bg-km-track px-2 text-[12px] text-km-text placeholder:text-km-faint focus-visible:ring-1 focus-visible:ring-km-accent";

/** Keys that identify a provider account, and so can be checked against one. */
const CHECKABLE: SettingKey[] = ["pixabayApiKey", "pexelsApiKey"];

/** Long enough that a key isn't probed on every keystroke, short enough to feel live. */
const CHECK_DEBOUNCE_MS = 700;

const STATUS_TONE: Record<StockKeyStatus, string> = {
  valid: "text-emerald-400",
  invalid: "text-red-300",
  unknown: "text-km-faint",
};

/** A verdict, kept together with the exact text it was reached for. */
interface KeyedVerdict {
  value: string;
  verdict: StockKeyVerdict;
}

function Field({
  label,
  hint,
  value,
  placeholder,
  onChange,
  verdict,
  busy,
}: {
  label: string;
  hint?: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  verdict?: StockKeyVerdict | null;
  busy?: boolean;
}) {
  return (
    <label className="block">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[11px] text-km-dim">{label}</span>
        {hint && <span className="text-[10px] text-km-faint">{hint}</span>}
      </div>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={inputClass}
        type="password"
        autoComplete="off"
        spellCheck={false}
      />
      {busy ? (
        <div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-km-faint">
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
          Checking…
        </div>
      ) : verdict?.message ? (
        <div className={`mt-1 flex items-start gap-1.5 text-[10.5px] leading-snug ${STATUS_TONE[verdict.status]}`}>
          {verdict.status === "valid" ? (
            <Check className="mt-px h-3 w-3 shrink-0" />
          ) : verdict.status === "invalid" ? (
            <AlertCircle className="mt-px h-3 w-3 shrink-0" />
          ) : (
            <HelpCircle className="mt-px h-3 w-3 shrink-0" />
          )}
          <span>{verdict.message}</span>
        </div>
      ) : null}
    </label>
  );
}

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [values, setValues] = useState<Record<SettingKey, string>>({
    pixabayApiKey: "",
    pexelsApiKey: "",
  });
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [verdicts, setVerdicts] = useState<Partial<Record<SettingKey, KeyedVerdict>>>({});
  const [checking, setChecking] = useState<Partial<Record<SettingKey, number>>>({});
  /** Probes already in the air, so a re-render can't start the same one twice. */
  const inFlight = useRef(new Set<string>());

  useEffect(() => {
    if (!open || loaded) return;
    void getAllSettings().then((all) => {
      setValues({
        pixabayApiKey: all.pixabayApiKey ?? "",
        pexelsApiKey: all.pexelsApiKey ?? "",
      });
      setLoaded(true);
    });
  }, [open, loaded]);

  const set = (key: SettingKey) => (value: string) => setValues((v) => ({ ...v, [key]: value }));

  /** The verdict for what's in the field *now* — a reply about older text has gone stale. */
  const verdictFor = useCallback(
    (key: SettingKey): StockKeyVerdict | null => {
      const value = values[key].trim();
      if (!value) return null;
      const entry = verdicts[key];
      return entry && entry.value === value ? entry.verdict : null;
    },
    [values, verdicts],
  );

  const runCheck = useCallback(async (key: SettingKey, value: string) => {
    const token = `${key}:${value}`;
    if (inFlight.current.has(token)) return;
    inFlight.current.add(token);
    setChecking((c) => ({ ...c, [key]: (c[key] ?? 0) + 1 }));
    try {
      const verdict = await validateStockKey(key, value);
      setVerdicts((v) => ({ ...v, [key]: { value, verdict } }));
    } finally {
      inFlight.current.delete(token);
      setChecking((c) => ({ ...c, [key]: Math.max(0, (c[key] ?? 0) - 1) }));
    }
  }, []);

  useEffect(() => {
    if (!open || !loaded) return;
    const timers = CHECKABLE
      .map((key) => {
        const value = values[key].trim();
        if (!value || verdicts[key]?.value === value) return null;
        return window.setTimeout(() => void runCheck(key, value), CHECK_DEBOUNCE_MS);
      })
      .filter((timer): timer is number => timer !== null);
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [open, loaded, values, verdicts, runCheck]);

  /** A key the provider turned down — the one thing that holds up saving. */
  const blocked = CHECKABLE.some((key) => verdictFor(key)?.status === "invalid");

  /** Whether a saved key survives a reload here, or only this session. */
  const persistent = settingsPersist();

  const save = async () => {
    setSaving(true);
    try {
      // Anything already settled is taken as it stands; everything else is
      // checked now, so a key pasted in and saved without pausing still gets
      // verified rather than sailing through unexamined.
      const verdictList = await Promise.all(
        CHECKABLE.filter((key) => values[key].trim()).map(async (key) => {
          const value = values[key].trim();
          const known = verdictFor(key);
          if (known) return known;
          const verdict = await validateStockKey(key, value);
          setVerdicts((v) => ({ ...v, [key]: { value, verdict } }));
          return verdict;
        }),
      );
      const refused = verdictList.find((verdict) => verdict.status === "invalid");
      if (refused) {
        toast.error("That key was rejected by the provider", { description: refused.message });
        return;
      }
      await Promise.all(
        (Object.keys(values) as SettingKey[]).map((key) => setSetting(key, values[key].trim() || null)),
      );
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] max-w-lg flex-col gap-0 overflow-hidden border-km-border bg-km-panel p-0 text-km-text">
        <DialogHeader className="shrink-0 border-b border-km-border px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-[15px] font-semibold text-km-text">
            <KeyRound className="h-4 w-4 text-km-accent" />
            Stock media keys
          </DialogTitle>
          <DialogDescription className="text-[11.5px] leading-relaxed text-km-faint">
            Free keys from each provider unlock its results in the Stock tab. Left blank, that source
            is simply skipped — Wikimedia and The Met need no key at all. Keys are checked as you
            paste them, and only a key the provider turns down holds up saving.
          </DialogDescription>
        </DialogHeader>

        <div className="km-scroll min-h-0 flex-1 space-y-3.5 overflow-y-auto px-5 py-4">
          <Field
            label="Pixabay API key"
            hint="pixabay.com/api/docs"
            value={values.pixabayApiKey}
            placeholder="Paste your Pixabay key"
            onChange={set("pixabayApiKey")}
            verdict={verdictFor("pixabayApiKey")}
            busy={(checking.pixabayApiKey ?? 0) > 0}
          />
          <Field
            label="Pexels API key"
            hint="pexels.com/api"
            value={values.pexelsApiKey}
            placeholder="Paste your Pexels key"
            onChange={set("pexelsApiKey")}
            verdict={verdictFor("pexelsApiKey")}
            busy={(checking.pexelsApiKey ?? 0) > 0}
          />
        </div>

        {persistent ? null : (
          <p className="mx-5 mb-3 flex shrink-0 items-start gap-1.5 rounded border border-km-border bg-km-track/50 px-2.5 py-2 text-[10.5px] leading-snug text-km-faint">
            <Info className="mt-px h-3 w-3 shrink-0" />
            <span>
              This page can't hold on to stored values, so a key saved here lasts for this session
              only — everything works, but it has to be pasted again after a reload.
            </span>
          </p>
        )}

        <DialogFooter className="shrink-0 gap-2 border-t border-km-border px-5 py-3">
          {blocked && (
            <p className="mr-auto flex items-center gap-1.5 text-[10.5px] text-red-300">
              <AlertCircle className="h-3 w-3 shrink-0" />
              Fix the rejected key to save.
            </p>
          )}
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            className="h-8 border border-km-border px-3 text-[12px] text-km-dim hover:bg-km-raised hover:text-km-text"
          >
            Close
          </Button>
          <Button
            onClick={() => void save()}
            disabled={saving || blocked}
            className="h-8 gap-1.5 bg-km-accent px-3 text-[12px] font-medium text-white hover:bg-km-accent2"
          >
            <KeyRound className="h-3.5 w-3.5" />
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
