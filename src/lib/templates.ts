/**
 * PROJECT TEMPLATES — a structure to start editing into, not a finished piece.
 *
 * A template is DATA (see `ProjectTemplate`): a set of beats, the rows below the
 * main layer, and the cards that sit on those rows. `buildTemplateProject` walks
 * that spec and returns a real `Project` plus its assets — it never touches the
 * store, so the same builder serves the picker in the UI and the MCP tools.
 *
 * HOW ONE IS BUILT, AND WHY THIS SHAPE:
 *
 *   · The backdrop is the PROJECT BACKGROUND, not a layer. The main layer is
 *     always the back of the stack, so a full-length plate on a row of its own
 *     would draw over the footage instead of under it — whereas
 *     `settings.backgroundKind` is painted behind everything, always.
 *   · The MAIN LAYER is a sequence of beat cards laid end to end. Consecutive
 *     cards touch, which makes every join a real junction — so the beats that
 *     ask for `into` get a transition BOND across the seam, and the template
 *     demonstrates the timeline's most useful feature just by being opened.
 *   · The rows under it are SEMANTIC — one per kind of on-air furniture, not one
 *     per beat: the flags that name the beats, the lower thirds, the ticker, the
 *     captions, the music bed. A rail that stays this short works for a four-beat
 *     explainer and a six-beat reel alike, and each row's clips sit in the order
 *     they play, so the rail reads the way the piece does.
 *   · Each card is a broadcast ELEMENT — a slate, an accent flag, a name plate, a
 *     ticker, a source line, a verdict pill — plated and hung off one margin, in
 *     the template's own palette. A template therefore opens looking designed
 *     rather than assembled.
 *
 * ONE LEFT AXIS, ONE MEASURED BOX.
 *
 * Every card is placed by ANCHOR, not by a fraction of the canvas: `styleFor`
 * picks the type, `anchorFor` picks the corner, and `placeText` measures the
 * rendered block (the compositor's own `measureText`, so the maths cannot drift
 * from the pixels) and lands its outer edge — plate included — on the template's
 * margin. That is what makes the flag above the slate line up with the slate,
 * and the slate with the lower third, at any font size and at any aspect.
 */
import { applyBond } from "@/lib/bonds";
import { DEFAULT_WRAP_RATIO, measureText } from "@/lib/compositor";
import { BACKGROUND_PRESETS } from "@/lib/library";
import { generateDemoAudio } from "@/lib/media";
import { DEFAULT_TEXT, createLayer, withNormalizedZ } from "@/lib/project";
import { MAIN_TRACK_NAME, createTrack, withTrackOrder } from "@/lib/tracks";
import { uid } from "@/lib/time";
import { DEFAULT_SETTINGS } from "@/store/editorStore";
import type {
  Asset,
  AssetId,
  Layer,
  LayerId,
  Project,
  ProjectSettings,
  TextStyle,
  Track,
  TrackId,
  Transform,
  Transition,
  TransitionType,
} from "@/types/editor";

export type TemplateId = "news" | "tutorial" | "facts" | "infographic" | "comparison" | "music" | "reel";

export type Aspect = "16:9" | "9:16" | "1:1";

const ASPECTS: Record<Aspect, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
};

/* ------------------------------------------------------------------ *
 * The spec
 * ------------------------------------------------------------------ */

/**
 * The colours and the two type families one template is designed in. A
 * template is a *design*, so its palette travels with it: change the accent and
 * every card that carries it changes together.
 */
export interface Palette {
  /** Flags, values, pills — the one colour that marks everything. */
  accent: string;
  /** Type set ON the accent, where the accent is a fill. */
  onAccent: string;
  /** Primary type. */
  ink: string;
  /** Secondary type: source lines, chart labels, decks. */
  muted: string;
  /** The plate a card sits on. */
  plate: string;
  /** A quieter plate, for tips and notes. */
  soft: string;
  display: string;
  body: string;
  /** Dark canvas — turns the drop shadow and the dark keyline on. */
  dark: boolean;
}

/** Where a card hangs. The edge named lands on the template's margin. */
export type Anchor =
  | "topLeft"
  | "topCenter"
  | "topRight"
  | "middleLeft"
  | "center"
  | "middleRight"
  | "lowerLeft"
  | "lowerCenter"
  | "lowerRight"
  | "lowerThird"
  | "strip";

/** One slot on the main layer: a card on the timeline and a row to fill it. */
interface Beat {
  /** Names the card on the timeline; the beat's flag is named from it too. */
  label: string;
  seconds: number;
  /** Bonded into the next beat. Omitted is a plain cut. */
  into?: TransitionType;
  /** The accent flag that names this beat, drawn on the kicker row. */
  kicker?: string;
  /** The slate's own copy. `\n` is an explicit line break, not a wrap hint. */
  card?: string;
}

interface TemplateRow {
  name: string;
  /** The row auto-captions land on. */
  captions?: boolean;
  /** The row the generated music bed goes on. */
  music?: boolean;
  /** One accent flag per beat is derived onto this row, timed to the beat. */
  kickers?: boolean;
}

type CardKind =
  | "beat"
  | "headline"
  | "kicker"
  | "chip"
  | "bar"
  | "stat"
  | "statCard"
  | "label"
  | "note"
  | "quote"
  | "ticker";

interface Card {
  /** Must name one of the template's rows. */
  row: string;
  kind: CardKind;
  /** `\n` splits lines. Keep each line short — the wrap is a safety net. */
  text: string;
  at: number;
  seconds: number;
  anchor?: Anchor;
  /** A vertical nudge, as a fraction of the canvas height. */
  dy?: number;
  /** Overrides the template accent — the two heads of a comparison. */
  accent?: string;
}

export interface ProjectTemplate {
  id: TemplateId;
  name: string;
  /** One line for the picker card. */
  blurb: string;
  /** When to reach for it. */
  use: string;
  aspect: Aspect;
  /** Id from `BACKGROUND_PRESETS`; supplies the flat backdrop behind everything. */
  background: string;
  /** The colours and families every card in this template is drawn in. */
  palette: Palette;
  /** Where the beat slates hang. Defaults to the left of centre. */
  beatAnchor?: Anchor;
  /** Slots on the main layer, laid end to end. */
  beats: Beat[];
  /** Rows below the main layer, top to bottom. */
  rows: TemplateRow[];
  /** Finishing content on those rows. */
  cards: Card[];
  /** Render a procedural music bed onto the row marked `music`. */
  music?: boolean;
}

/* ------------------------------------------------------------------ *
 * The templates
 * ------------------------------------------------------------------ */

const SANS = "Inter, system-ui, sans-serif";
const SERIF = "Georgia, 'Times New Roman', serif";

export const TEMPLATES: ProjectTemplate[] = [
  {
    id: "news",
    name: "News bulletin",
    blurb: "Anchor-led rundown with accent flags, lower thirds and a live ticker.",
    use: "Reporting, announcements and anything that opens on a headline.",
    aspect: "16:9",
    background: "bgMidnight",
    palette: {
      accent: "#e0102f",
      onAccent: "#ffffff",
      ink: "#ffffff",
      muted: "#b9c6d8",
      plate: "rgba(5,10,24,0.84)",
      soft: "rgba(255,255,255,0.14)",
      display: SANS,
      body: SANS,
      dark: true,
    },
    beats: [
      {
        label: "Cold open",
        seconds: 3,
        into: "fade",
        kicker: "● LIVE · COLD OPEN",
        card: "Ceasefire resolution\nrejected 52–48",
      },
      {
        label: "Headline",
        seconds: 6,
        into: "dissolve",
        kicker: "TOP STORY · HEADLINE",
        card: "What the vote changes\nfor the next 30 days",
      },
      {
        label: "Report 1",
        seconds: 8,
        into: "dissolve",
        kicker: "REPORT 1 · THE CAPITOL",
        card: "From the Capitol\nFour swing votes, one tie",
      },
      {
        label: "Report 2",
        seconds: 8,
        into: "fade",
        kicker: "REPORT 2 · TEHRAN",
        card: "On the ground in Tehran\nReaction from the streets",
      },
      {
        label: "Sign-off",
        seconds: 4,
        kicker: "SIGN-OFF · 21:58",
        card: "That's the bulletin\nFull coverage continues at 22:00",
      },
    ],
    rows: [
      { name: "Kickers", kickers: true },
      { name: "Lower thirds" },
      { name: "Ticker" },
      { name: "Captions", captions: true },
      { name: "Music bed", music: true },
    ],
    cards: [
      {
        row: "Ticker",
        kind: "ticker",
        text: "● LIVE · CEASEFIRE RESOLUTION DEFEATED 52–48 · MARKETS OPEN LOWER · FULL COVERAGE AT 22:00",
        at: 0.2,
        seconds: 28.6,
      },
      { row: "Lower thirds", kind: "bar", text: "ANCHOR NAME\nNEWSROOM · WASHINGTON", at: 3.3, seconds: 5.5 },
      { row: "Lower thirds", kind: "bar", text: "REPORTER NAME\nTHE CAPITOL", at: 9.3, seconds: 6.5 },
      { row: "Lower thirds", kind: "bar", text: "REPORTER NAME\nTEHRAN", at: 17.3, seconds: 6.5 },
    ],
    music: true,
  },
  {
    id: "tutorial",
    name: "Step-by-step tutorial",
    blurb: "A numbered rundown with a slate per step and room for a tip.",
    use: "How-to walkthroughs where the order of the steps is the content.",
    aspect: "16:9",
    background: "bgStudio",
    palette: {
      accent: "#22d3ee",
      onAccent: "#04222b",
      ink: "#f8fafc",
      muted: "#c3d3e0",
      plate: "rgba(8,14,24,0.84)",
      soft: "rgba(34,211,238,0.16)",
      display: SANS,
      body: SANS,
      dark: true,
    },
    beats: [
      { label: "Intro", seconds: 4, into: "fade", kicker: "INTRO", card: "Export in three steps\nStart with the sequence settings" },
      { label: "Step 1", seconds: 6, into: "fade", kicker: "STEP 1 · SEQUENCE", card: "Match the frame rate\nbefore you cut anything" },
      { label: "Step 2", seconds: 6, into: "fade", kicker: "STEP 2 · THE CUT", card: "Trim, then ripple\nNever drag a gap closed" },
      { label: "Step 3", seconds: 6, into: "fade", kicker: "STEP 3 · THE GRADE", card: "Grade the sequence\nnot the single clips" },
      { label: "Result", seconds: 5, kicker: "RESULT", card: "Watch it once full-screen\nbefore you export" },
    ],
    rows: [
      { name: "Steps", kickers: true },
      { name: "Tips" },
      { name: "Captions", captions: true },
      { name: "Music bed", music: true },
    ],
    cards: [
      {
        row: "Tips",
        kind: "note",
        text: "TIP · Set the frame rate first — everything downstream inherits it.",
        at: 4.4,
        seconds: 4.4,
      },
      {
        row: "Tips",
        kind: "note",
        text: "TIP · Grading the whole sequence first keeps every clip consistent.",
        at: 16.4,
        seconds: 4.4,
      },
    ],
    music: true,
  },
  {
    id: "facts",
    name: "Fact list",
    blurb: "Vertical hook-and-facts format, numbered, built to be scrolled.",
    use: "Short vertical lists, tips and trivia with one point per beat.",
    aspect: "9:16",
    background: "bgSunset",
    palette: {
      accent: "#ffd166",
      onAccent: "#2b1a03",
      ink: "#ffffff",
      muted: "#ffeccc",
      plate: "rgba(30,8,44,0.72)",
      soft: "rgba(255,255,255,0.16)",
      display: SANS,
      body: SANS,
      dark: true,
    },
    beats: [
      {
        label: "Hook",
        seconds: 3,
        into: "whip",
        kicker: "KNOW THIS",
        card: "Three things the\n52–48 vote\ndidn't tell you",
      },
      {
        label: "Fact 1",
        seconds: 8,
        into: "whip",
        kicker: "01 / 03",
        card: "It wasn't a vote\non the war —\nit was a vote on funding",
      },
      { label: "Fact 2", seconds: 8, into: "whip", kicker: "02 / 03", card: "Four senators\nchanged sides\nsince the last one" },
      {
        label: "Fact 3",
        seconds: 8,
        into: "whip",
        kicker: "03 / 03",
        card: "The identical text\ncomes back to\nthe floor in November",
      },
      { label: "Follow", seconds: 4, kicker: "FOLLOW", card: "Follow for the\nnext one on\nMonday" },
    ],
    rows: [
      { name: "Numbers", kickers: true },
      { name: "Captions", captions: true },
      { name: "Music bed", music: true },
    ],
    cards: [
      { row: "Numbers", kind: "label", text: "SOURCE · SENATE RECORD", at: 11.2, seconds: 12.8, anchor: "lowerThird" },
      { row: "Numbers", kind: "chip", text: "FOLLOW FOR MORE", at: 27.4, seconds: 3.4, anchor: "lowerCenter" },
    ],
    music: true,
  },
  {
    id: "infographic",
    name: "Infographic explainer",
    blurb: "Light canvas, labelled figures, one takeaway at the end.",
    use: "Explaining a chart, a process or a set of numbers.",
    aspect: "16:9",
    background: "bgPaper",
    palette: {
      accent: "#0f766e",
      onAccent: "#ffffff",
      ink: "#0b1c2c",
      muted: "#51616f",
      plate: "rgba(255,255,255,0.94)",
      soft: "rgba(15,118,110,0.12)",
      display: SANS,
      body: SANS,
      dark: false,
    },
    beats: [
      { label: "The question", seconds: 4, into: "fade", kicker: "THE QUESTION", card: "Do ceasefire votes\never change the war?" },
      {
        label: "Data point A",
        seconds: 7,
        into: "fade",
        kicker: "DATA · SINCE 1991",
        card: "Every ceasefire vote\nsince 1991, in one line",
      },
      {
        label: "Data point B",
        seconds: 7,
        into: "fade",
        kicker: "DATA · THE FLIPS",
        card: "The four senators\nwho changed their vote",
      },
      { label: "Takeaway", seconds: 5, kicker: "THE TAKEAWAY", card: "What actually\nmoves a swing vote" },
    ],
    rows: [
      { name: "Charts", kickers: true },
      { name: "Labels" },
      { name: "Captions", captions: true },
      { name: "Music bed", music: true },
    ],
    cards: [
      { row: "Charts", kind: "statCard", text: "72%", at: 4.2, seconds: 3.4, anchor: "middleRight" },
      { row: "Charts", kind: "statCard", text: "18%", at: 11.2, seconds: 3.4, anchor: "middleRight" },
      {
        row: "Labels",
        kind: "label",
        text: "of ceasefire votes since 1991\nchanged the outcome",
        at: 4.2,
        seconds: 3.4,
        anchor: "lowerRight",
      },
      {
        row: "Labels",
        kind: "label",
        text: "of swing senators flipped\nwithout a public statement",
        at: 11.2,
        seconds: 3.4,
        anchor: "lowerRight",
      },
      {
        row: "Labels",
        kind: "quote",
        text: "“Three of the four said it was never about the war.”",
        at: 18.3,
        seconds: 4.4,
        anchor: "lowerThird",
      },
      { row: "Labels", kind: "label", text: "SOURCE · SENATE RECORD", at: 0.4, seconds: 4, anchor: "strip" },
    ],
    music: true,
  },
  {
    id: "comparison",
    name: "A vs B comparison",
    blurb: "Two headed columns, one of them green and one orange, then a verdict.",
    use: "Weighing two options, tools or approaches on screen.",
    aspect: "16:9",
    background: "bgInk",
    palette: {
      accent: "#38bdf8",
      onAccent: "#04121f",
      ink: "#ffffff",
      muted: "#9fb0c0",
      plate: "rgba(9,13,20,0.88)",
      soft: "rgba(255,255,255,0.12)",
      display: SANS,
      body: SANS,
      dark: true,
    },
    beats: [
      { label: "Setup", seconds: 4, into: "slide", card: "Same footage, two editors\nOne week with each" },
      { label: "Option A", seconds: 7, into: "slide", card: "Option A\nFaster to cut, busier timeline" },
      { label: "Option B", seconds: 7, into: "fade", card: "Option B\nSlower to set up, calmer to finish" },
      { label: "Verdict", seconds: 5, card: "The verdict\nA for speed, B for sanity" },
    ],
    rows: [{ name: "Column heads" }, { name: "Verdict" }, { name: "Captions", captions: true }],
    cards: [
      { row: "Column heads", kind: "chip", text: "OPTION A", at: 0.6, seconds: 16.4, anchor: "topLeft", accent: "#22c55e" },
      { row: "Column heads", kind: "chip", text: "OPTION B", at: 0.6, seconds: 16.4, anchor: "topRight", accent: "#f97316" },
      {
        row: "Column heads",
        kind: "label",
        text: "SAME FOOTAGE\nSAME CAMERA\nSAME MACHINE",
        at: 0.6,
        seconds: 3.2,
        anchor: "lowerThird",
      },
      { row: "Verdict", kind: "chip", text: "ADD YOUR VERDICT HERE", at: 18.4, seconds: 4.4, anchor: "lowerCenter" },
    ],
  },
  {
    id: "music",
    name: "Music / lyric video",
    blurb: "Vertical sections, a centred lyric line and a rendered backing bed.",
    use: "Putting a track on screen, with lyrics over generated visuals.",
    aspect: "9:16",
    background: "bgSunset",
    palette: {
      accent: "#f0abfc",
      onAccent: "#2c0733",
      ink: "#ffffff",
      muted: "#f6d9ff",
      plate: "rgba(30,6,46,0.62)",
      soft: "rgba(255,255,255,0.14)",
      display: SANS,
      body: SANS,
      dark: true,
    },
    // The lyric line owns the middle of the frame, so the slates sit under it.
    beatAnchor: "lowerThird",
    beats: [
      { label: "Intro", seconds: 4, into: "fade", kicker: "INTRO", card: "Track title\nArtist name" },
      { label: "Verse", seconds: 10, into: "dissolve", kicker: "VERSE", card: "Verse one\nLines land on the beat" },
      { label: "Chorus", seconds: 10, into: "dissolve", kicker: "CHORUS", card: "Chorus\nEverything opens up" },
      { label: "Outro", seconds: 4, kicker: "OUTRO", card: "Outro\nFade on the last chord" },
    ],
    rows: [{ name: "Lyrics" }, { name: "Sections", kickers: true }, { name: "Music bed", music: true }],
    cards: [
      { row: "Lyrics", kind: "quote", text: "First line of the verse", at: 4.2, seconds: 3.4, anchor: "center" },
      { row: "Lyrics", kind: "quote", text: "Second line, still the verse", at: 7.8, seconds: 3.4, anchor: "center" },
      { row: "Lyrics", kind: "quote", text: "The chorus lands here", at: 14.2, seconds: 3.6, anchor: "center" },
      { row: "Lyrics", kind: "quote", text: "And it lifts from there", at: 18, seconds: 3.6, anchor: "center" },
      { row: "Sections", kind: "chip", text: "♪ TRACK TITLE", at: 0.4, seconds: 3.2, anchor: "topCenter" },
    ],
    music: true,
  },
  {
    id: "reel",
    name: "Short-form reel",
    blurb: "A two-second hook then four beats on a tight rhythm.",
    use: "Fast vertical cuts where the first second has to earn the rest.",
    aspect: "9:16",
    background: "bgMidnight",
    palette: {
      accent: "#facc15",
      onAccent: "#231a02",
      ink: "#ffffff",
      muted: "#cbd5e1",
      plate: "rgba(4,8,20,0.76)",
      soft: "rgba(250,204,21,0.16)",
      display: SANS,
      body: SANS,
      dark: true,
    },
    beats: [
      { label: "Hook", seconds: 2, into: "whip", kicker: "HOOK", card: "Stop scrolling\nThis setting changed my edit" },
      { label: "Beat 1", seconds: 3, into: "whip", kicker: "01", card: "Set the frame rate\nbefore you cut anything" },
      { label: "Beat 2", seconds: 3, into: "whip", kicker: "02", card: "Trim, then ripple\nNever drag a gap closed" },
      { label: "Beat 3", seconds: 3, into: "whip", kicker: "03", card: "Grade the sequence\nnot the single clips" },
      { label: "Beat 4", seconds: 3, into: "fade", kicker: "04", card: "Watch it once\nfull-screen before export" },
      { label: "Call to action", seconds: 3, kicker: "FOLLOW", card: "Follow for more\n30-second edits" },
    ],
    rows: [{ name: "Flags", kickers: true }, { name: "Captions", captions: true }, { name: "Music bed", music: true }],
    cards: [{ row: "Flags", kind: "chip", text: "SAVE THIS", at: 14.2, seconds: 2.6, anchor: "lowerCenter" }],
    music: true,
  },
];

export const templateById = (id: string): ProjectTemplate | undefined => TEMPLATES.find((t) => t.id === id);

/** The catalogue as plain data — what a tool response or a picker lists. */
export function templateSummaries() {
  return TEMPLATES.map((template) => ({
    id: template.id,
    name: template.name,
    blurb: template.blurb,
    use: template.use,
    aspect: template.aspect,
    background: template.background,
    accent: template.palette.accent,
    seconds: template.beats.reduce((total, beat) => total + beat.seconds, 0),
    beats: template.beats.map((beat) => ({ label: beat.label, seconds: beat.seconds })),
    rows: ["Main layer", ...template.rows.map((row) => row.name)],
    music: !!template.music,
  }));
}

/* ------------------------------------------------------------------ *
 * Type — what each kind of card is set in
 * ------------------------------------------------------------------ */

/**
 * Type is sized from the SHORT side of the canvas, so a 1080-wide portrait
 * frame gets the same-looking type as a 1080-tall landscape one instead of
 * something half the width of the screen.
 */
function styleFor(
  kind: CardKind,
  palette: Palette,
  settings: ProjectSettings,
  content: string,
  accent: string,
): { text: TextStyle; anchor: Anchor } {
  const unit = Math.min(settings.width, settings.height);
  const base = DEFAULT_TEXT(settings);
  /** A plated card carries its own legibility, so it needs no shadow. */
  const keyline = palette.dark;
  const key = Math.max(2, unit * 0.004);

  switch (kind) {
    /* The slot itself: a left-aligned slate on a plate. */
    case "beat":
      return {
        text: {
          ...base,
          content,
          fontFamily: palette.display,
          fontSize: Math.round(unit * 0.048),
          fontWeight: 800,
          lineHeight: 1.18,
          color: palette.ink,
          align: "left",
          backgroundColor: palette.plate,
          backgroundRadius: Math.round(unit * 0.008),
          shadow: false,
        },
        anchor: "middleLeft",
      };
    /* Display type with no plate — for a hero line that has to carry itself. */
    case "headline":
      return {
        text: {
          ...base,
          content,
          fontFamily: palette.display,
          fontSize: Math.round(unit * 0.075),
          fontWeight: 900,
          lineHeight: 1.12,
          color: palette.ink,
          align: "left",
          strokeColor: keyline ? "#05070d" : palette.ink,
          strokeWidth: keyline ? key : 0,
          shadow: keyline,
        },
        anchor: "lowerThird",
      };
    /* The accent flag that names a beat. */
    case "kicker":
      return {
        text: {
          ...base,
          content,
          fontFamily: palette.body,
          fontSize: Math.round(unit * 0.022),
          fontWeight: 800,
          letterSpacing: unit * 0.005,
          color: accent,
          align: "left",
          backgroundColor: palette.plate,
          backgroundRadius: Math.round(unit * 0.004),
          shadow: false,
        },
        anchor: "topLeft",
      };
    /* A filled pill — a call to action or a column head. */
    case "chip":
      return {
        text: {
          ...base,
          content,
          fontFamily: palette.body,
          fontSize: Math.round(unit * 0.024),
          fontWeight: 800,
          letterSpacing: unit * 0.004,
          color: palette.onAccent,
          align: "center",
          backgroundColor: accent,
          backgroundRadius: 999,
          shadow: false,
        },
        anchor: "lowerCenter",
      };
    /* A name plate: who is talking. */
    case "bar":
      return {
        text: {
          ...base,
          content,
          fontFamily: palette.display,
          fontSize: Math.round(unit * 0.032),
          fontWeight: 700,
          lineHeight: 1.28,
          color: palette.ink,
          align: "left",
          backgroundColor: palette.plate,
          backgroundRadius: Math.round(unit * 0.006),
          shadow: false,
        },
        anchor: "lowerThird",
      };
    /* A bare figure, in the accent. */
    case "stat":
      return {
        text: {
          ...base,
          content,
          fontFamily: palette.display,
          fontSize: Math.round(unit * 0.15),
          fontWeight: 900,
          color: accent,
          align: "center",
          strokeColor: keyline ? "#05070d" : accent,
          strokeWidth: keyline ? key : 0,
          shadow: keyline,
        },
        anchor: "center",
      };
    /* A figure on an accent card — the plate is the bar of a bar chart. */
    case "statCard":
      return {
        text: {
          ...base,
          content,
          fontFamily: palette.display,
          fontSize: Math.round(unit * 0.115),
          fontWeight: 900,
          color: palette.onAccent,
          align: "center",
          backgroundColor: accent,
          backgroundRadius: Math.round(unit * 0.012),
          shadow: false,
        },
        anchor: "middleRight",
      };
    /* Small caps aside — a source, a chart label, a caveat. */
    case "label":
      return {
        text: {
          ...base,
          content,
          fontFamily: palette.body,
          fontSize: Math.round(unit * 0.02),
          fontWeight: 600,
          letterSpacing: unit * 0.002,
          lineHeight: 1.3,
          color: palette.muted,
          align: "left",
          shadow: false,
        },
        anchor: "lowerRight",
      };
    /* A tip, on a quiet tinted plate. */
    case "note":
      return {
        text: {
          ...base,
          content,
          fontFamily: palette.body,
          fontSize: Math.round(unit * 0.026),
          fontWeight: 600,
          lineHeight: 1.35,
          color: palette.ink,
          align: "left",
          backgroundColor: palette.soft,
          backgroundRadius: Math.round(unit * 0.008),
          shadow: false,
        },
        anchor: "lowerThird",
      };
    case "quote":
      return {
        text: {
          ...base,
          content,
          fontFamily: SERIF,
          fontSize: Math.round(unit * 0.042),
          fontWeight: 400,
          lineHeight: 1.35,
          color: palette.ink,
          align: "center",
          shadow: palette.dark,
        },
        anchor: "center",
      };
    /* A running strip at the very bottom of the frame. */
    case "ticker":
      return {
        text: {
          ...base,
          content,
          fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
          fontSize: Math.round(unit * 0.024),
          fontWeight: 700,
          color: palette.ink,
          align: "left",
          backgroundColor: palette.plate,
          backgroundRadius: Math.round(unit * 0.003),
          shadow: false,
        },
        anchor: "strip",
      };
  }
}

/* ------------------------------------------------------------------ *
 * Placement
 * ------------------------------------------------------------------ */

type VertStop = "top" | "middle" | "bottom" | "lowerThird" | "strip";
type HorizStop = "left" | "center" | "right";

const ANCHOR_GRID: Record<Anchor, { y: VertStop; x: HorizStop }> = {
  topLeft: { y: "top", x: "left" },
  topCenter: { y: "top", x: "center" },
  topRight: { y: "top", x: "right" },
  middleLeft: { y: "middle", x: "left" },
  center: { y: "middle", x: "center" },
  middleRight: { y: "middle", x: "right" },
  lowerLeft: { y: "bottom", x: "left" },
  lowerCenter: { y: "bottom", x: "center" },
  lowerRight: { y: "bottom", x: "right" },
  lowerThird: { y: "lowerThird", x: "left" },
  strip: { y: "strip", x: "left" },
};

/**
 * The transform that hangs a block off an anchor.
 *
 * Measured rather than guessed: the block is sized by the compositor's own
 * `measureText` at the same wrap width the compositor will draw it with, so the
 * outer edge of the CARD — the plate, not the type — lands on the margin, and a
 * big slate and a small flag share one left axis. The plate's padding is
 * `fontSize * 0.32` across and `* 0.18` down, exactly as `paintText` draws it.
 */
function placeText(style: TextStyle, settings: ProjectSettings, anchor: Anchor, dy = 0): Transform {
  const { width, height } = settings;
  const unit = Math.min(width, height);
  const portrait = height > width;
  const margin = unit * (portrait ? 0.075 : 0.055);
  const grid = ANCHOR_GRID[anchor];

  const block = measureText(style, width * DEFAULT_WRAP_RATIO);
  const plated = !!style.backgroundColor && style.backgroundColor !== "transparent";
  const boxW = block.width + (plated ? style.fontSize * 0.32 : 0) * 2;
  const boxH = block.height + (plated ? style.fontSize * 0.18 : 0) * 2;

  const stop: Record<VertStop, number> = {
    top: margin,
    middle: height / 2,
    // Portrait keeps a deeper bottom margin: the last fifth is covered by the
    // platform's own furniture, so type has to stop before it gets there.
    bottom: portrait ? height * 0.8 : height - margin,
    lowerThird: portrait ? height * 0.68 : height * 0.8,
    strip: height - margin * 0.3,
  };

  const at = stop[grid.y];
  const y = grid.y === "top" ? at + boxH / 2 : grid.y === "middle" ? at : at - boxH / 2;
  const x = grid.x === "left" ? margin + boxW / 2 : grid.x === "center" ? width / 2 : width - margin - boxW / 2;

  return { x, y: y + dy * height, scale: 1, rotation: 0 };
}

/* ------------------------------------------------------------------ *
 * Building
 * ------------------------------------------------------------------ */

export interface BuiltProject {
  project: Project;
  assets: Record<AssetId, Asset>;
  /** Rail rows, top to bottom. */
  rows: string[];
  duration: number;
  /** Anything worth telling the caller, in plain words. */
  notes: string[];
}

export interface BuildTemplateOptions {
  /** Overrides the template name as the project's name. */
  name?: string;
  /** Render the music bed. Defaults to whatever the template asks for. */
  music?: boolean;
}

/** Longest bed rendered — a procedural render is cheap, an unbounded one is not. */
const MAX_MUSIC_SECONDS = 45;

/** Graphics arrive and leave rather than blinking on. */
const ramp = (seconds: number): Transition => ({ type: "fade", duration: seconds, direction: "left" });
/** Kinds that are on-air furniture, and so animate. */
const ANIMATED: CardKind[] = ["kicker", "chip", "bar", "note"];

/** First line of a card, short enough to read in the timeline rail. */
const nameFor = (text: string) => text.split("\n")[0].slice(0, 24);

/**
 * Turns a template into a project. Pure: nothing here reads or writes the
 * store, so a caller can build one, inspect it, and decide whether to load it.
 */
export async function buildTemplateProject(
  template: ProjectTemplate,
  options: BuildTemplateOptions = {},
): Promise<BuiltProject> {
  const notes: string[] = [];
  const { width, height } = ASPECTS[template.aspect];
  const palette = template.palette;
  const preset = BACKGROUND_PRESETS.find((entry) => entry.id === template.background);

  const settings: ProjectSettings = {
    ...DEFAULT_SETTINGS,
    ...(preset?.project ?? {}),
    name: options.name?.trim() || template.name,
    width,
    height,
  };
  if (!preset?.project) {
    // A preset that declares no flat backdrop (the procedural ones) would leave
    // an empty timeline black on black, so fall back to the solid end of its own
    // palette rather than to nothing.
    settings.backgroundKind = "color";
    settings.backgroundColor = preset && /^#/.test(preset.style.color) ? preset.style.color : "#05060a";
  }

  const duration = template.beats.reduce((total, beat) => total + beat.seconds, 0) || 1;

  /* The bed is rendered before the timeline is built, because a layer needs a
     real asset id and the audio has to exist to have one. */
  const musicRow = template.rows.find((row) => row.music);
  const wantMusic = (options.music ?? template.music ?? false) && !!musicRow;
  let music: Asset | undefined;
  if (wantMusic) {
    try {
      const seconds = Math.min(Math.max(duration, 6), MAX_MUSIC_SECONDS);
      music = (await generateDemoAudio(seconds)).asset;
    } catch {
      notes.push("The music bed could not be rendered in this browser, so the music row is empty.");
    }
  }

  const mainTrack = createTrack(MAIN_TRACK_NAME, true);
  const tracks: Track[] = [mainTrack, ...template.rows.map((row) => createTrack(row.name, false, row.captions))];
  const trackByName = new Map(template.rows.map((row, index) => [row.name, tracks[index + 1].id]));

  const layers: Record<LayerId, Layer> = {};
  const layerIds: LayerId[] = [];
  const place = (layer: Layer, trackId: TrackId): Layer => {
    const placed = { ...layer, trackId };
    layers[placed.id] = placed;
    layerIds.push(placed.id);
    return placed;
  };
  /** A text card, styled and hung by anchor. */
  const text = (
    kind: CardKind,
    name: string,
    content: string,
    startTime: number,
    seconds: number,
    anchor?: Anchor,
    accent?: string,
    dy?: number,
  ): Layer => {
    const look = styleFor(kind, palette, settings, content, accent ?? palette.accent);
    const at = anchor ?? look.anchor;
    return createLayer({
      type: "text",
      name,
      startTime,
      duration: Math.max(0.4, seconds),
      text: look.text,
      transform: placeText(look.text, settings, at, dy),
      ...(ANIMATED.includes(kind)
        ? { transitionIn: ramp(0.28), transitionOut: ramp(Math.min(0.28, seconds / 3)) }
        : {}),
    });
  };

  /* --- the beats: one slate per slot, laid end to end on the main layer --- */
  const beatAnchor = template.beatAnchor ?? "middleLeft";
  const beatCards: Layer[] = [];
  let cursor = 0;
  for (const beat of template.beats) {
    beatCards.push(
      place(
        text("beat", beat.label, beat.card ?? beat.label.toUpperCase(), cursor, beat.seconds, beatAnchor),
        mainTrack.id,
      ),
    );
    cursor += beat.seconds;
  }

  /* --- the beat flags: accent lines naming which slot you are in, derived
         from the beats so they can never drift out of time with them --- */
  const kickerRow = template.rows.find((row) => row.kickers);
  const kickerTrack = kickerRow ? trackByName.get(kickerRow.name) : undefined;
  let flags = 0;
  if (kickerTrack) {
    let at = 0;
    for (const beat of template.beats) {
      if (beat.kicker) {
        place(text("kicker", `${beat.label} flag`, beat.kicker, at, beat.seconds), kickerTrack);
        flags++;
      }
      at += beat.seconds;
    }
  }

  /* --- the rest of the on-air furniture --- */
  for (const card of template.cards) {
    const trackId = trackByName.get(card.row);
    // A card naming a row the template does not have is a bug in the spec, not
    // something to crash a build over.
    if (!trackId) continue;
    place(
      text(card.kind, nameFor(card.text), card.text, card.at, card.seconds, card.anchor, card.accent, card.dy),
      trackId,
    );
  }

  /* --- the music bed, covering the whole piece rather than needing to loop --- */
  if (music && musicRow) {
    const trackId = trackByName.get(musicRow.name);
    if (trackId) {
      place(
        createLayer({
          type: "audio",
          name: "Music bed",
          assetId: music.id,
          startTime: 0,
          duration,
          volume: 0.45,
          audioFadeIn: 1,
          audioFadeOut: Math.min(2, duration / 4),
          transform: { x: width / 2, y: height / 2, scale: 1, rotation: 0 },
        }),
        trackId,
      );
    }
  }

  const tracksById: Record<TrackId, Track> = {};
  for (const track of tracks) tracksById[track.id] = track;

  let project: Project = withTrackOrder(
    withNormalizedZ({
      id: uid("project"),
      templateId: template.id,
      settings,
      layers,
      layerIds,
      trackIds: tracks.map((track) => track.id),
      tracks: tracksById,
    }),
  );

  /* --- bond the joins the template asked for ------------------------- */
  /* Done after the project exists rather than while placing, because a bond
     needs both clips to already be in the document: it extends the outgoing
     clip past the seam and hands the enter-ramp to the incoming one. */
  for (let index = 0; index < beatCards.length - 1; index++) {
    const transition = template.beats[index].into;
    if (!transition) continue;
    project = applyBond(project, beatCards[index].id, beatCards[index + 1].id, {
      type: transition,
      duration: 0.5,
    });
  }

  const bonded = template.beats.filter((beat) => beat.into).length;
  notes.push(
    `${template.beats.length} beat cards run end to end on the main layer; the ${template.rows.length} rows beneath them hold the furniture — flags, plates, ticker, captions, music.`,
  );
  if (bonded) notes.push(`${bonded} of the joins are bonded transitions rather than hard cuts.`);
  if (flags) notes.push(`${flags} accent flags on the ${kickerRow?.name} row name the beat you are in, timed to it.`);
  const furniture = template.cards.filter((card) => trackByName.has(card.row)).length;
  if (furniture) notes.push(`${furniture} finishing cards hang off one left axis: lower thirds, labels and calls to action.`);
  if (music) notes.push("A procedural music bed is under the whole piece on the music row.");

  return {
    project,
    assets: music ? { [music.id]: music } : {},
    rows: tracks.map((track) => track.name),
    duration: cursor,
    notes,
  };
}
