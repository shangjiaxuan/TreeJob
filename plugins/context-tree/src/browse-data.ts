import { callCommand } from "./rpc.js";
import {
  ListResultSchema,
  RevisionListResultSchema,
  RevisionShowResultSchema,
  type CurrentWork,
  type EntrySummary,
  type NodeRevisionSummary,
  type RecordStatus,
} from "./schema.js";

export type BrowserTreeEntry = {
  name: string;
  path: string;
  title: string;
  status: RecordStatus;
  children: BrowserTreeEntry[];
};

export type BrowserView = {
  sessionId: string;
  currentPath: string;
  selectedRevision: NodeRevisionSummary;
  work: CurrentWork;
  entries: EntrySummary[];
  revisions: NodeRevisionSummary[];
  tree: BrowserTreeEntry;
};

export async function readBrowserView(
  sessionId: string,
  path: string,
  revisionId: number | undefined,
): Promise<BrowserView> {
  const [listed, revisionList, tree] = await Promise.all([
    list(sessionId, path),
    revisions(sessionId, path),
    readTree(sessionId, "/", "/", "", "open"),
  ]);
  const selectedRevision = revisionId === undefined
    ? revisionList.revisions[0]
    : revisionList.revisions.find((revision) => revision.revisionId === revisionId);

  if (!selectedRevision) {
    throw new Error("revision is not available at the requested path");
  }

  const shown = RevisionShowResultSchema.parse(await callCommand({
    sessionId,
    command: ["rev-show", selectedRevision.revisionId, path],
  }));

  return {
    sessionId,
    currentPath: listed.listedPath,
    selectedRevision: shown.details.revision,
    work: shown.details.work,
    entries: shown.details.entries,
    revisions: revisionList.revisions,
    tree,
  };
}

async function readTree(
  sessionId: string,
  path: string,
  name: string,
  title: string,
  status: RecordStatus,
): Promise<BrowserTreeEntry> {
  const listed = await list(sessionId, path);
  const children = await Promise.all(listed.entries.map(async (entry) => {
    const childPath = joinPath(listed.listedPath, entry.name);
    const child = await readTree(
      sessionId,
      childPath,
      entry.name,
      entry.title,
      entry.status,
    );
    return child;
  }));

  return {
    name,
    path: listed.listedPath,
    title,
    status,
    children,
  };
}

async function list(sessionId: string, path: string) {
  return ListResultSchema.parse(await callCommand({
    sessionId,
    command: ["ls", path],
  }));
}

async function revisions(sessionId: string, path: string) {
  return RevisionListResultSchema.parse(await callCommand({
    sessionId,
    command: ["rev-list", path],
  }));
}

function joinPath(parent: string, name: string): string {
  const segment = escapePathSegment(name);
  return parent === "/" ? "/" + segment : parent + "/" + segment;
}

function escapePathSegment(name: string): string {
  const escaped = name.replaceAll("\\", "\\\\").replaceAll("/", "\\/");
  return escaped === "." || escaped === ".." ? "\\" + escaped : escaped;
}
