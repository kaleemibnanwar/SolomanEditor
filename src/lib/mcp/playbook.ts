/**
 * THE EDITING PLAYBOOK.
 *
 * The research, written for an agent. An LLM that can call `split_clip` does not
 * automatically know *when* to split, why a cut should land on an action, or
 * what "picture lock" gates. This module is that missing craft knowledge,
 * exposed to clients three ways:
 *
 *   · `initialize.instructions` — the short version, always in context;
 *   · the `octo-cut://playbook` resource — the full text, fetchable on demand;
 *   · the prompts — the same material turned into concrete, staged workflows.
 *
 * It is deliberately specific to how THIS editor is built (layers on tracks, one
 * main visual sequence, geometry-derived junctions), so the guidance an agent
 * reads matches the tools it actually has.
 */

/** Always-in-context orientation. Kept short: the full text is a resource. */
export const SERVER_INSTRUCTIONS = `This server is the live editing session of "Octo Cut", a non-destructive
timeline editor. The user is almost certainly looking at it while you work, and everything you do
appears on screen immediately.

The timeline is LAYERS arranged on TRACKS. One track is the MAIN LAYER: the primary visual
sequence, drawn at the back of the stack with every other row (titles, stickers, overlays, audio)
in front of it. Clips that touch on a track form a JUNCTION, which is what a transition bond
attaches to. Nothing is ever destructive — clips hold an in-point and a duration into source media,
so trimming never alters the asset.

Work belongs to a PROJECT. list_projects (or the octo-cut://projects resource) shows the saved
library; create_project and open_project move between projects, and save_project writes one out
immediately. Work saves itself a couple of seconds after each edit, so a save is only needed when
you want it written NOW. Note that create_project and open_project REPLACE what is open and clear
the undo history — never call one to try something out on someone's cut.

Start every session with get_editor_state, then get_timeline. Read octo-cut://playbook for the
editing workflow, and prefer the flow_* tools for multi-step work: one flow_assembly_cut call
builds a whole rough cut, where doing it by hand would take a dozen calls.

For work you will do again, capture it: save_macro records a recipe of steps with {{slots}} and
run_macro replays it in one call; apply_manifest composes a whole piece from a declarative JSON
manifest (media by key, one duration driver, validate_manifest to dry-run it first). Both compile
to the same Step[] and collapse to one undo.

This server is a video editor, not a media factory: it does NOT search stock, generate images, music or
speech. You own that side — use your own tools to source or create the media, then hand each file's URL
to import_media, which loads it into the editor exactly like a dropped file. For a finished piece in a
branded look, list_brands shows the brand packs and templates; apply_template builds one;
add_text / import_media / add_media_clip fill the rows; enforce_brand_rules checks the result against
the brand's checklist; export_video renders it. generate_video assembles a whole piece in one call from
asset ids already in the bin.

After a change, verify with whats_on_screen or get_timeline rather than assuming it landed.`;

/* ------------------------------------------------------------------ *
 * The full playbook
 * ------------------------------------------------------------------ */

export const EDITING_PLAYBOOK = `# How to edit

An editing session is not a list of mutations. It is a sequence of *stages*, and each stage has a
different question. Working in stage order is what stops a cut from being re-done four times.

## 1. Ingest and organise

Before anything is cut, the material is looked at and named. Call \`list_assets\` to see what is
available: each asset carries its duration, natural size and (for audio) a peak waveform.

Keep \`list_assets\` in your head as a bin. An editor who has not watched the footage picks badly;
if you do not know what an asset contains, say so rather than guessing from its name.

## 2. Assembly — the editor's cut

The assembly is the *most basic cut possible*: every usable piece laid end to end, in order, with
no judgement applied yet. It is expected to be too long. Its only job is to prove the material
covers the story.

\`\`\`
flow_assembly_cut({ clips: [{ assetId, inPoint, duration }, ...] })
\`\`\`

This lays clips back to back on the main layer, each starting where the previous one ended. Because
they touch, every seam is a junction you can later put a transition on.

## 3. Rough cut — trim to the story

Now the assembly is cut down. This is where the four relationships between two shots are actually
decided, and they are worth checking on every single cut:

- **Graphic** — do the two shots look like they belong together? Light and dark, line and shape,
  movement and stasis. A cut from a dark shot to a blown-out one is jarring.
- **Rhythmic** — how long is each shot, and what does that length do? Short shots accelerate.
  Holding a shot lets an audience react. \`flow_beat_cut\` will lay clips on a musical pulse when a
  piece wants to be cut to music.
- **Spatial** — does the audience know where they are? An establishing shot earns the close-ups
  that follow it.
- **Temporal** — what happens to time? A cut can compress an hour into a second, or stretch one.

Practical rules that survived a century of cutting:

- Cut on the action, not after it. The eye follows movement through a cut.
- Do not cut to a shot of the same size and angle as the one before — it reads as a mistake.
- Let a shot breathe for at least a beat; ~1.5–2s is the practical floor for a human to read an
  image. Shorter than that and it is a flash, which is a choice, not a default.
- When in doubt, cut sooner.

Tools: \`trim_clip\` (trim_clip is non-destructive, it only moves the in-point), \`move_clip\`,
\`split_clip\` to cut mid-clip, \`delete_clips\`.

## 4. Fine cut — joins, sound and pace

- **Three-point editing** is the canonical NLE move: you mark an in and an out in the SOURCE, and
  one point in the SEQUENCE, and the edit fills the gap. \`flow_three_point_edit\` does it.
  - **Overwrite** lands the clip on top and leaves the timeline length alone.
  - **Insert** ripples everything after the point later, so nothing is lost and the timeline grows.
- **Ripple delete** — \`flow_ripple_delete\` removes a clip and closes the gap, so the following
  material slides up to meet what came before.
- **Split edits** — the sound and the picture change at different moments. When the audio of the
  NEXT shot arrives before its picture, that is a **J-cut** (the audience hears it coming). When the
  audio of the PREVIOUS shot runs on under the next picture, that is an **L-cut**. Together they
  are what makes cutting feel invisible. \`flow_split_edit\` sets either up.
- **Transitions** belong at junctions. A hard cut is the default and usually correct; a dissolve
  says "time passed"; a wipe is a period or a graphic choice; a flash is punctuation. Put a
  transition on a junction with \`set_junction_transition\` — that bonds the two clips so the
  incoming one really cross-draws over the outgoing one, which is different from fading a single
  clip up over whatever happens to be beneath it.
  Keep them short: 0.3–0.8s. A long dissolve at every cut is the mark of a first draft.

## 5. Titles, graphics and grade

- \`flow_title_sequence\` builds an opening title; \`flow_lower_third\` names a speaker over a clip.
- Titles sit on their own track in front of the picture, so they are already drawn above it — do
  not try to move them onto the main layer.
- Grade for consistency before you grade for style. \`apply_look\` with a look id from
  \`list_library\` gives every clip the same base; \`flow_grade_sequence\` applies one across a
  sequence in a single call. Then adjust individual clips with \`set_clip_grade\` and
  \`set_clip_filters\`.
- Movement you add in the edit — a slow push in — is a factual, not a decorative, tool: it gives a
  static shot life. \`flow_push_in\`.

## 6. Picture lock

Picture lock is the gate: after it, the timing of the picture does not change, which is what lets
sound and graphics be finished against a fixed target. Run \`flow_picture_lock\` when the cut is
settled. It reports anything still loose and locks the clips so later passes cannot nudge them.

## 7. Export

\`export_project\` queues a real render. Export is a realtime capture, so it runs at playback speed,
the tab must stay in the foreground, and the playhead will be moved while it runs. Check progress
with \`get_export_status\`.

## Working with a human who is watching

- The user can see the timeline. Narrate what you are about to change in one line before you
  change it, then confirm what actually changed.
- \`get_selection\` tells you what they are pointing at; \`control_playback\` moves their playhead.
  Both change what they see — do not scrub someone's playhead to inspect a clip you could read with
  \`get_clip\`.
- Prefer \`whats_on_screen\` over guessing which layer is visible at a given moment.
- Every write is one undo step per call. A wrong change is cheap; batch 30 changes into one call
  and you have taken the undo button away from the person using it. Work in reviewable chunks.

## Starting points

Do not compose from a blank timeline every time. \`list_templates\` shows the built-in recipes and any
snapshots saved earlier; \`list_brands\` shows the brand packs. Begin with \`create_project\` (a recipe
id, a saved \`snapshot\`, or neither for a blank project), then \`set_brand\` if the project has none.
\`save_template\` captures the current project's structure so the next piece starts from it, not from zero.

A snapshot can declare \`slots\` — the fields that change each run (the word, the lower third) — so a
later \`create_project { snapshot, slots }\` fills them rather than rebuilding. For a whole workflow,
\`save_macro\` records a recipe of steps with \`{{slots}}\` and \`run_macro\` replays it. For a one-shot
piece an LLM authors from scratch, \`apply_manifest\` loads a declarative JSON composition (validate it
first with \`validate_manifest\`).

## Reference: every tool

**Observe** — \`get_editor_state\`, \`get_timeline\`, \`get_clip\`, \`whats_on_screen\`,
\`get_selection\`, \`list_assets\`, \`list_library\`, \`get_activity\`, \`get_export_status\`

**Control** — \`add_media_clip\`, \`add_text_clip\`, \`add_shape\`, \`add_sticker\`, \`add_effect\`,
\`add_background\`, \`set_clip_properties\`, \`set_clip_transform\`, \`set_clip_filters\`,
\`set_clip_grade\`, \`apply_look\`, \`move_clip\`, \`trim_clip\`, \`split_clip\`, \`delete_clips\`,
\`duplicate_clips\`, \`reorder_clip\`, \`reorder_track\`, \`set_clip_transition\`, \`set_junction_transition\`,
\`manage_keyframes\`, \`manage_track\`, \`select_clips\`, \`control_playback\`,
\`update_project_settings\`, \`export_project\`, \`edit_history\`

**Import** — \`import_media\`

**Projects** — \`list_templates\`, \`get_template\`, \`save_template\`, \`delete_template\`,
\`list_projects\`, \`create_project\`, \`open_project\`, \`save_project\`, \`delete_project\`

**Macros** — \`list_macros\`, \`get_macro\`, \`save_macro\`, \`run_macro\`, \`delete_macro\`

**Manifest** — \`validate_manifest\`, \`apply_manifest\`

**Broadcast** — \`list_timeline_rows\`, \`list_stream_configs\`, \`save_stream_config\`,
\`delete_stream_config\`, \`broadcast_status\`, \`start_broadcast\`, \`stop_broadcast\` — live-stream a
file OR the composed timeline to RTMP/SRT/RTSP (YouTube, Twitch, hardware encoders, private servers).
Requires the desktop app + ffmpeg.

**Content** — \`list_brands\`, \`set_brand\`, \`create_timeline\`, \`apply_template\`, \`add_text\`,
\`generate_video\`, \`enforce_brand_rules\`, \`export_video\`, \`generate_thumbnail\`,
\`generate_chapters\`

**Flows** — \`flow_assembly_cut\`, \`flow_three_point_edit\`, \`flow_ripple_delete\`,
\`flow_split_edit\`, \`flow_title_sequence\`, \`flow_lower_third\`, \`flow_grade_sequence\`,
\`flow_beat_cut\`, \`flow_crosscut\`, \`flow_push_in\`, \`flow_social_reframe\`,
\`flow_trim_silence\`, \`flow_picture_lock\`
`;

/* ------------------------------------------------------------------ *
 * Prompts — the playbook turned into staged, callable workflows
 * ------------------------------------------------------------------ */

export interface PromptTemplate {
  name: string;
  title: string;
  description: string;
  arguments: { name: string; description: string; required?: boolean }[];
  render: (args: Record<string, string>) => string;
}

const or = (value: string | undefined, fallback: string) => (value?.trim() ? value.trim() : fallback);

export const PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    name: "assemble_rough_cut",
    title: "Assemble a rough cut",
    description: "Take the available footage through the assembly and rough-cut stages, then report what the cut still needs.",
    arguments: [
      { name: "brief", description: "What the piece is for, and anything known about running order", required: true },
      { name: "target_duration", description: "Target length in seconds, if there is one" },
    ],
    render: (a) => `Edit a rough cut in the live Octo Cut session.

Brief: ${or(a.brief, "(not given — ask, or proceed from the footage you find)")}
Target duration: ${or(a.target_duration, "no fixed target")}

Work in stages, and narrate one line before each:

1. get_editor_state, then list_assets and get_timeline to see what exists and what is already cut.
2. Decide a running order from the material that is genuinely there. Do not invent assets.
3. Use flow_assembly_cut to lay it out end to end on the main layer. Expect it to be too long — that
   is the point of an assembly.
4. Trim it to the story: for every seam, check the graphic, rhythmic, spatial and temporal
   relationship between the outgoing and incoming shot, and trim so the cut lands on action.
   Use trim_clip and flow_ripple_delete.
5. Read octo-cut://playbook if you need the craft rules in full.

Leave titles, grade and transitions for a later pass — a rough cut is about story order and length.
Finish with get_timeline and tell me the resulting duration, the running order, and the three
weakest joins you can see.`,
  },
  {
    name: "polish_sequence",
    title: "Polish a sequence",
    description: "Take a cut that already works and do the fine-cut pass: joins, transitions, pace, titles, grade.",
    arguments: [
      { name: "notes", description: "What the user wants changed", required: true },
      { name: "clip_ids", description: "Comma-separated clip ids to focus on, if any" },
    ],
    render: (a) => `Do a fine-cut pass on the Octo Cut session.

Notes: ${a.notes || "(none)"}
Focus clips: ${or(a.clip_ids, "the whole sequence")}

This is the pass that makes a cut feel finished:

- Joins. Look for junctions that should carry a transition and use set_junction_transition — short
  ones (0.3–0.8s). Do not put a transition on every cut; cuts are the default.
- Split edits. Where a change of scene should be felt before it is seen (or after), use
  flow_split_edit for a J-cut or an L-cut.
- Pace. Read the shot lengths in get_timeline. Anything under ~1.5s that is not a deliberate flash
  is probably too short; anything long and static may want flow_push_in to give it life.
- Graphics. flow_lower_third for anyone who needs naming; flow_title_sequence if the piece has no
  opening.
- Grade. apply_look for a consistent base across the sequence, then set_clip_grade per clip.

Verify each change with whats_on_screen before moving on, and tell me anything you decided NOT to
do and why.`,
  },
  {
    name: "social_cut",
    title: "Cut for social",
    description: "Reformat the piece for a vertical or square platform and tighten the opening.",
    arguments: [
      { name: "platform", description: "e.g. TikTok / Reels (9:16), Instagram feed (4:5), square (1:1)" },
      { name: "hook_seconds", description: "How long the opening has to earn attention" },
    ],
    render: (a) => `Reformat this Octo Cut project for ${or(a.platform, "vertical short-form (9:16)")}.

1. flow_social_reframe to set the canvas and refit every layer's framing.
2. The opening is the whole game here. The first ${or(a.hook_seconds, "1.5")} seconds must carry
   real movement or a real statement — trim into the action rather than building up to it.
3. Cut to a shorter overall length: flow_beat_cut if there is music, otherwise tighten every join
   with trim_clip and flow_ripple_delete.
4. Check every graphic still sits inside frame after the reframe — use whats_on_screen and
   get_clip, and move anything that is now off-screen or illegible.

Report the new duration and the framing decisions you had to make.`,
  },
  {
    name: "review_edit",
    title: "Review the edit",
    description: "Read-only critique of the current cut, with no changes made.",
    arguments: [{ name: "focus", description: "What to scrutinise, if anything" }],
    render: (a) => `Review the current Octo Cut timeline. MAKE NO CHANGES — this is a reading pass only.

Focus: ${or(a.focus, "the cut as a whole")}

Use get_editor_state, get_timeline, get_selection, whats_on_screen and get_clip. For each clip and
each junction, judge:

- Is the shot long enough to read? Is any shot carrying more time than it earns?
- Does each cut land on action, or does it land in dead space?
- Do consecutive shots differ in size, angle or content, or does the cut read as a mistake?
- Are the transitions doing a job, or are they decoration?
- Is the grade consistent, and does anything drift between clips?
- Does anything sit outside the frame, or under a graphic that hides it?

Report as a list of specific, actionable problems, each naming the clip ids involved and the tool
you would use to fix it. Be concrete and be willing to say the cut is fine.`,
  },
  {
    name: "auto_edit",
    title: "Produce a branded video",
    description: "Source the media yourself, load it, then compose a brand-styled piece and render.",
    arguments: [
      { name: "template", description: "Template id from list_brands", required: true },
      { name: "topic", description: "The one-word subject (e.g. OIL, IRAN, CHIPS)" },
      { name: "script", description: "The narration line or two, for which you produce the audio" },
    ],
    render: (a) => `Produce a branded video in the live Octo Cut session.

Template: ${or(a.template, "(ask, or pick one with list_brands)")}
Topic: ${or(a.topic, "a single word, uppercased")}
Script: ${or(a.script, "no narration")}

This server is a video editor only — you source and create the media. Work in this order:

1. list_brands, then read octo-cut://playbook if you need the craft rules. Decide the brand and
   template that fit the topic.
2. With your OWN tools, produce or find: a faint dark topic cue image, the narration audio, and a
   looping music bed. Note the brand's palette, voice profile and music mood from list_brands so the
   media matches the theme and concept.
3. Load each file with import_media (one call per file — a URL, a name, an optional kind).
4. Apply the template with apply_template, overriding the massive word and lower third for the topic.
   Then either assemble in one call with generate_video (pass the cue/voice/music asset ids from
   list_assets) or place things by hand with add_media_clip and add_text.
5. Run enforce_brand_rules to check the result against the brand's checklist, and fix what it reports.
6. export_video to render, then poll get_export_status.

Finish by reporting which brand/template you used, which media you loaded, and which brand rules (if
any) still fail.`,
  },
];

export const PROMPT_BY_NAME: Record<string, PromptTemplate> = Object.fromEntries(
  PROMPT_TEMPLATES.map((p) => [p.name, p]),
);
