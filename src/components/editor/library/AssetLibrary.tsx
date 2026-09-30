/**
 * The asset library — the editor's left panel.
 *
 * KineMaster's shape: a vertical category rail next to one content column. The
 * rail is the *only* navigation, so a tab that has nothing to show says so in
 * the content column rather than disappearing.
 *
 * The active tab and the search text live in the store, so switching to the
 * timeline and back does not lose what the user was looking for.
 */
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeftRight,
  Clapperboard,
  Globe,
  Images,
  Layers,
  Music2,
  Palette,
  Shapes,
  Smile,
  Sparkles,
  Type,
  Wand2,
} from "lucide-react";
import AudioTab from "@/components/editor/library/AudioTab";
import FilterTab from "@/components/editor/library/FilterTab";
import MediaTab from "@/components/editor/library/MediaTab";
import { BackgroundGrid, EffectGrid } from "@/components/editor/library/OverlayTab";
import { SearchField } from "@/components/editor/library/pieces";
import StockTab from "@/components/editor/library/StockTab";
import { ShapeGrid, StickerGrid, TextGrid } from "@/components/editor/library/StickerTab";
import TransitionTab from "@/components/editor/library/TransitionTab";
import { cn } from "@/lib/utils";
import { editor, useEditor } from "@/store/editorStore";
import type { LibraryTab } from "@/types/editor";

interface TabMeta {
  id: LibraryTab;
  /** Rail caption — short, because the rail is narrow. */
  label: string;
  icon: LucideIcon;
  title: string;
  hint: string;
  placeholder: string;
}

const TABS: TabMeta[] = [
  {
    id: "media",
    label: "Media",
    icon: Images,
    title: "Media",
    hint: "Everything imported into this project",
    placeholder: "Search your media",
  },
  {
    id: "stock",
    label: "Stock",
    icon: Globe,
    title: "Stock",
    hint: "Free media from open archives",
    placeholder: "Search stock media",
  },
  {
    id: "video",
    label: "Video",
    icon: Clapperboard,
    title: "Video clips",
    hint: "Video already in the project",
    placeholder: "Search video",
  },
  {
    id: "audio",
    label: "Audio",
    icon: Music2,
    title: "Audio",
    hint: "Narration, generated sounds and imported tracks",
    placeholder: "Search sounds",
  },
  {
    id: "overlay",
    label: "Overlay",
    icon: Sparkles,
    title: "Overlays",
    hint: "Light and particles drawn over the frame",
    placeholder: "Search overlays",
  },
  {
    id: "effect",
    label: "Effect",
    icon: Wand2,
    title: "Effects",
    hint: "Textures and full-frame plates",
    placeholder: "Search effects",
  },
  {
    id: "transition",
    label: "Trans",
    icon: ArrowLeftRight,
    title: "Transitions",
    hint: "Placed on the edge of the selected clip",
    placeholder: "Search transitions",
  },
  {
    id: "filter",
    label: "Filter",
    icon: Palette,
    title: "Filters",
    hint: "Looks applied to the selected clip",
    placeholder: "Search filters",
  },
  {
    id: "shape",
    label: "Shape",
    icon: Shapes,
    title: "Shapes",
    hint: "Vector shapes with fills and strokes",
    placeholder: "Search shapes",
  },
  {
    id: "sticker",
    label: "Sticker",
    icon: Smile,
    title: "Stickers",
    hint: "Emoji and badges placed at the playhead",
    placeholder: "Search stickers",
  },
  {
    id: "text",
    label: "Text",
    icon: Type,
    title: "Text",
    hint: "Titles, captions and lower thirds",
    placeholder: "Search text styles",
  },
  {
    id: "background",
    label: "Back",
    icon: Layers,
    title: "Backgrounds",
    hint: "Full-frame backdrops behind every layer",
    placeholder: "Search backdrops",
  },
];

export default function AssetLibrary({ tabs }: { tabs?: LibraryTab[] } = {}) {
  const tab = useEditor((s) => s.ui.libraryTab);
  const query = useEditor((s) => s.ui.libraryQuery);

  /** A mode can restrict the rail to a subset of categories (the image editor
   *  hides video/audio/stock/transitions). Empty/omitted shows the whole rail. */
  const visibleTabs = tabs?.length ? TABS.filter((entry) => tabs.includes(entry.id)) : TABS;
  const meta = visibleTabs.find((entry) => entry.id === tab) ?? visibleTabs[0];

  return (
    <aside className="flex w-[272px] shrink-0 border-r border-km-border bg-km-panel">
      <nav
        aria-label="Asset categories"
        className="km-scroll-none flex w-[58px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-km-border bg-km-panel2/50 px-1 py-1.5"
      >
        {visibleTabs.map((entry) => (
          <RailButton
            key={entry.id}
            meta={entry}
            active={entry.id === meta.id}
            onSelect={() => editor().setUi({ libraryTab: entry.id })}
          />
        ))}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="shrink-0 px-2.5 pb-2 pt-2.5">
          <h2 className="text-[12px] font-semibold leading-tight text-km-text">{meta.title}</h2>
          <p className="mt-0.5 text-[10px] leading-snug text-km-faint">{meta.hint}</p>
          <div className="mt-2">
            <SearchField
              value={query}
              onChange={(next) => editor().setUi({ libraryQuery: next })}
              placeholder={meta.placeholder}
            />
          </div>
        </header>

        <div className="km-scroll min-h-0 flex-1 overflow-y-auto px-2.5 pb-4">
          <TabBody tab={meta.id} query={query} />
        </div>
      </div>
    </aside>
  );
}

/**
 * The one place a tab id turns into a component. Tabs that read the same
 * catalogue differ only by the slice they hand it — there is no second grid.
 */
function TabBody({ tab, query }: { tab: LibraryTab; query: string }) {
  switch (tab) {
    case "media":
      return <MediaTab query={query} />;
    case "video":
      return <MediaTab query={query} kinds={["video"]} />;
    case "stock":
      return <StockTab query={query} />;
    case "audio":
      return <AudioTab query={query} />;
    case "overlay":
      return <EffectGrid groups={["light", "particles"]} query={query} />;
    case "effect":
      return <EffectGrid groups={["texture", "plate"]} query={query} />;
    case "transition":
      return <TransitionTab query={query} />;
    case "filter":
      return <FilterTab query={query} />;
    case "shape":
      return <ShapeGrid query={query} />;
    case "sticker":
      return <StickerGrid query={query} />;
    case "text":
      return <TextGrid query={query} />;
    case "background":
      return <BackgroundGrid query={query} />;
  }
}

/* ------------------------------------------------------------------ *
 * Rail
 * ------------------------------------------------------------------ */

function RailButton({
  meta,
  active,
  onSelect,
}: {
  meta: TabMeta;
  active: boolean;
  onSelect: () => void;
}) {
  const Icon = meta.icon;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      title={`${meta.title} — ${meta.hint}`}
      className={cn(
        "group flex shrink-0 flex-col items-center gap-1 rounded-lg px-1 py-[7px] transition",
        active ? "bg-km-accent/15" : "hover:bg-km-panel2",
      )}
    >
      <Icon
        className={cn(
          "h-4 w-4 transition",
          active ? "text-km-accent" : "text-km-faint group-hover:text-km-text",
        )}
      />
      <span className={cn("text-[9.5px] leading-none", active ? "text-km-text" : "text-km-dim")}>
        {meta.label}
      </span>
    </button>
  );
}
