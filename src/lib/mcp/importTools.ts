/**
 * IMPORT TOOLS — how an agent's own media enters the editor.
 *
 * The MCP surface deliberately does NOT search stock, synthesise speech or
 * generate images/music: the agent already has its own tools for that, and it
 * holds the context of the project (which brand, which theme, which intro,
 * which bed). This tool is the bridge — the agent produces or finds a file and
 * hands its URL in; the editor downloads it through the ordinary import path
 * and places it on the timeline, exactly like a file dropped into the window.
 *
 * That is the whole reason `import_media` mirrors `add_media_clip`: the same
 * `trackId`/`start`/`duration`/`inPoint`/transform vocabulary, so a loaded
 * file composes with the rest of the plan the agent builds.
 */
import { assetMetaPatch, createAssetsFromFiles, detectKind } from "@/lib/media";
import { readLocalFile } from "@/lib/mcp/host";
import {
  WRITE,
  applyPlan,
  argNumber,
  argString,
  choice,
  num,
  object,
  present,
  str,
  transformPatch,
  type ToolDefinition,
} from "@/lib/mcp/kit";
import type { Step } from "@/lib/mcp/steps";
import { textResult, toolError } from "@/lib/mcp/protocol";
import { editor } from "@/store/editorStore";

const KINDS = ["image", "video", "audio"] as const;
type Kind = (typeof KINDS)[number];

const EXT_BY_KIND: Record<Kind, string> = { image: "jpg", video: "mp4", audio: "mp3" };

/** Fetches a URL into a File whose kind the import path can detect. */
async function fetchToFile(url: string, name: string | undefined, kind: Kind | undefined): Promise<File> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`Could not fetch "${url}" — ${err instanceof Error ? err.message : "network error"}.`);
  }
  if (!res.ok) throw new Error(`Download failed (${res.status}) for "${url}".`);
  const blob = await res.blob();

  const ext = kind ? EXT_BY_KIND[kind] : (url.split("?")[0].split(".").pop()?.toLowerCase() ?? "");
  const mime = kind ? `${kind}/${ext}` : blob.type || "application/octet-stream";
  const base = (name || "media").replace(/\.[^.]+$/, "");
  const fileName = /\./.test(base) ? base : `${base}.${ext || "bin"}`;
  return new File([blob], fileName, { type: mime });
}

/**
 * Reads a file the agent already has on this machine's disk, through the
 * desktop bridge. Mirrors `fetchToFile`: the result is a `File` whose name
 * carries the right extension so the ordinary import path detects its kind,
 * and whose type is a real MIME (an empty type sniffs poorly inside `<video>`).
 */
async function fileFromPath(filePath: string, name: string | undefined, kind: Kind | undefined): Promise<File> {
  const loaded = await readLocalFile(filePath);

  const ext = kind ? EXT_BY_KIND[kind] : (filePath.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase() ?? "");
  const base = (name || loaded.name || "media").replace(/\.[^.]+$/, "");
  const fileName = /\./.test(base) ? base : `${base}.${ext || "bin"}`;

  const probe = new File([loaded.data], fileName, { type: "" });
  const detected = kind ?? detectKind(probe);
  const mime = detected ? `${detected}/${ext}` : "";

  return new File([loaded.data], fileName, { type: mime });
}

export const IMPORT_TOOLS: ToolDefinition[] = [
  {
    name: "import_media",
    title: "Load a media file",
    description:
      "Load a file the agent already produced or found — an image cue, a music bed, a spoken line — into the editor and place it on the timeline. Give either a `path` to a local file (read straight off disk, desktop app only) or a `url` (http(s) or data:) for the editor to download. Either way it goes through the normal import path, so it gets a thumbnail, waveform and metadata like a dropped file. Same placement options as add_media_clip. There is no search or synthesis here: the media must already exist somewhere the editor can reach.",
    inputSchema: object(
      {
        path: str("Absolute path to a local media file on this machine (desktop app only).", { minLength: 1 }),
        url: str("Direct URL to the file (http(s), or a data: URL).", { minLength: 1 }),
        name: str("Name for the asset. Defaults to the file name."),
        kind: choice("Media kind. Auto-detected from the path or URL when omitted.", [...KINDS]),
        license: str("Licence or credit, recorded on the asset."),
        creator: str("Creator or source, recorded on the asset."),
        pageUrl: str("Page to credit the work, recorded on the asset."),
        start: num("Where on the timeline the clip begins, in seconds. Defaults to the playhead.", { minimum: 0 }),
        duration: num("How long the clip plays, in seconds. Defaults to the rest of the source.", { minimum: 0.06 }),
        inPoint: num("Seconds into the source media the clip starts from.", { minimum: 0 }),
        trackId: str("Row to place it on. Omit for the default row for this media kind."),
        x: num("Clip centre x in project pixels."),
        y: num("Clip centre y in project pixels."),
        scale: num("Scale multiplier, where 1 fits the media to the canvas.", { minimum: 0.0001 }),
        rotation: num("Rotation in degrees."),
      },
    ),
    annotations: WRITE,
    run: async (args) => {
      const url = argString(args, "url");
      const path = argString(args, "path");
      const name = argString(args, "name");
      const kind = argString(args, "kind") as Kind | undefined;

      if (!path && !url) {
        return toolError("Give either a `path` (local file, desktop app) or a `url` (http(s) or data:).");
      }

      let file: File;
      try {
        file = path ? await fileFromPath(path, name, kind) : await fetchToFile(url!, name, kind);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : "The file could not be loaded.");
      }

      const [created] = createAssetsFromFiles([file]);
      if (!created) {
        return toolError(
          `"${file.name}" is not a supported media type — pass an explicit kind (image, video or audio), or a URL whose file ends in a known extension.`,
        );
      }

      editor().addAsset(created.asset);
      const loaded = await created.meta;
      editor().updateAsset(created.asset.id, assetMetaPatch(loaded));

      const license = argString(args, "license");
      const creator = argString(args, "creator");
      const pageUrl = argString(args, "pageUrl");
      if (license || creator || pageUrl) {
        editor().updateAsset(created.asset.id, {
          source: {
            provider: "agent",
            label: name,
            author: creator,
            license,
            pageUrl,
          },
        });
      }

      const steps: Step[] = [
        {
          kind: "addMedia",
          assetId: created.asset.id,
          start: argNumber(args, "start") ?? editor().currentTime,
          ...present({
            duration: argNumber(args, "duration"),
            inPoint: argNumber(args, "inPoint"),
            trackId: argString(args, "trackId"),
          }),
        },
      ];
      const transform = transformPatch(args);
      if (transform) steps.push({ kind: "setTransform", id: "$0", ...transform });

      return applyPlan("import_media", steps, {
        notes: license ? [`${license} — credit ${name ?? "the source"}`] : undefined,
      });
    },
  },
];
