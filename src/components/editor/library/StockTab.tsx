/**
 * The Stock tab: live search against the stock sources in `@/lib/stock`.
 *
 * Downloads are pulled to a Blob and imported through the ordinary file path, so
 * a stock photo behaves exactly like one dragged in from the desktop — same
 * thumbnail, same waveform, and no cross-origin canvas taint at export time.
 */
import { useEffect, useMemo, useState } from "react";
import { Film, Image as ImageIcon, KeyRound, Loader2, Music2, Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  CardTag,
  ChipRow,
  EmptyState,
  Hint,
  LibraryCard,
  SectionLabel,
} from "@/components/editor/library/pieces";
import { startMediaDrag, stockPayload } from "@/lib/mediaDrag";
import { subscribeSettings } from "@/lib/settings";
import {
  describeStockError,
  importStock,
  searchStock,
  stockErrorCode,
  stockSourcesFor,
  type StockItem,
  type StockKind,
  type StockSource,
} from "@/lib/stock";
import { editor } from "@/store/editorStore";
import { formatDurationLong } from "@/lib/time";
import { cn } from "@/lib/utils";

const KINDS: { id: StockKind; label: string; Icon: LucideIcon }[] = [
  { id: "image", label: "Images", Icon: ImageIcon },
  { id: "audio", label: "Audio", Icon: Music2 },
  { id: "video", label: "Video", Icon: Film },
];

export default function StockTab({ query }: { query: string }) {
  const [kind, setKind] = useState<StockKind>("image");
  const [source, setSource] = useState<StockSource>("wikimedia");
  const [items, setItems] = useState<StockItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  // `missingKey` is kept alongside the message so the error can offer the one
  // action that would fix it instead of just reporting the problem.
  const [error, setError] = useState<{ message: string; missingKey: boolean } | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  // Bumped whenever a key is saved, so the search below re-runs: a key that was
  // missing when the query was typed is the whole reason there is an error here,
  // and nothing else about the query has changed to retrigger it.
  const [settingsRev, setSettingsRev] = useState(0);

  useEffect(() => subscribeSettings(() => setSettingsRev((n) => n + 1)), []);

  const sources = useMemo(() => stockSourcesFor(kind), [kind]);
  const text = query.trim();

  // A source that cannot serve the chosen kind would just return nothing, so
  // follow the kind to the first source that can.
  useEffect(() => {
    if (!sources.some((option) => option.id === source)) setSource(sources[0].id);
  }, [sources, source]);

  useEffect(() => {
    if (!text) {
      setItems(null);
      setError(null);
      setBusy(false);
      return;
    }
    const controller = new AbortController();
    setBusy(true);
    setError(null);

    const timer = setTimeout(() => {
      searchStock({ text, source, kind, limit: 24, signal: controller.signal })
        .then((found) => {
          if (controller.signal.aborted) return;
          setItems(found);
          setBusy(false);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setItems([]);
          setError({ message: describeStockError(err), missingKey: stockErrorCode(err) === "missing-key" });
          setBusy(false);
        });
    }, 320);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text, source, kind, settingsRev]);

  const activeSource = sources.find((option) => option.id === source);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-1 rounded-lg border border-km-border bg-km-panel2 p-1">
        {KINDS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setKind(id)}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-md py-1.5 text-[10.5px] transition",
              id === kind
                ? "bg-km-accent/18 text-km-text"
                : "text-km-dim hover:bg-km-raised/50 hover:text-km-text",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      <ChipRow<StockSource>
        options={sources.map((option) => ({ value: option.id, label: option.label }))}
        value={source}
        onChange={setSource}
      />

      {!text ? (
        <EmptyState>
          Search {activeSource?.label ?? "the open collections"} for {kind} you can actually use —
          everything found here is openly licensed and credited to your project on import.
        </EmptyState>
      ) : busy ? (
        <p className="flex items-center gap-1.5 px-0.5 py-3 text-[10.5px] text-km-faint">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Searching {activeSource?.label ?? "the collections"}…
        </p>
      ) : error ? (
        <>
          <EmptyState>{error.message}</EmptyState>
          {error.missingKey && (
            <button
              type="button"
              onClick={() => editor().setUi({ settingsOpen: true })}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-km-accent/50 bg-km-accent/10 py-2 text-[11px] text-km-text transition hover:bg-km-accent/20"
            >
              <KeyRound className="h-3.5 w-3.5" />
              Open Settings to add the key
            </button>
          )}
        </>
      ) : items && items.length === 0 ? (
        <EmptyState>
          Nothing in {activeSource?.label} for “{text}”. Try a broader word, or another source above.
        </EmptyState>
      ) : items ? (
        <>
          <SectionLabel right={`${items.length}`}>{activeSource?.blurb ?? "Results"}</SectionLabel>
          <div className="grid grid-cols-2 gap-2">
            {items.map((item) => (
              <StockCard
                key={`${item.source}:${item.id}`}
                item={item}
                busy={importing === item.id}
                onImport={() => {
                  setImporting(item.id);
                  void importStock(item).finally(() => setImporting((id) => (id === item.id ? null : id)));
                }}
              />
            ))}
          </div>
        </>
      ) : null}

      <Hint>
        Wikimedia Commons · The Met Open Access · Pixabay · Pexels. Licences are copied onto each asset, so
        credits travel with the project.
      </Hint>
    </div>
  );
}

function StockCard({ item, busy, onImport }: { item: StockItem; busy: boolean; onImport: () => void }) {
  const detail = item.kind === "image" ? (item.width ? `${item.width}×${item.height}` : "image") : undefined;

  return (
    <LibraryCard
      label={item.title}
      hint={detail ?? (item.duration ? formatDurationLong(item.duration) : (item.creator ?? item.license))}
      onClick={onImport}
      dragStart={(e) => startMediaDrag(stockPayload(item), e)}
      disabled={busy}
      actionIcon={busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
      actionTitle="Download and add to this project"
      onAction={onImport}
      badge={<CardTag>{item.kind}</CardTag>}
      preview={
        <div className="km-checker h-full w-full">
          <img
            src={item.thumbUrl}
            alt=""
            loading="lazy"
            draggable={false}
            className="h-full w-full object-cover"
          />
          <div className="absolute bottom-1 left-1 right-1 flex items-center justify-between gap-1">
            <span className="truncate rounded bg-black/70 px-1 py-0.5 text-[9px] text-white/80 backdrop-blur">
              {item.license}
            </span>
          </div>
        </div>
      }
    />
  );
}
