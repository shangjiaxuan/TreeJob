import { callCommand } from "./rpc.js";
import {
  ListResultSchema,
  RevisionListResultSchema,
  RevisionShowResultSchema,
  type CurrentWork,
  type EntrySummary,
  type RecordStatus,
  type RevisionSummary,
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
  selectedRevision: RevisionSummary;
  referenceRevision: number;
  work: CurrentWork;
  entries: EntrySummary[];
  revisions: RevisionSummary[];
  tree: BrowserTreeEntry;
};

export async function readBrowserView(
  sessionId: string,
  path: string,
  revision: number | undefined,
  reference: number | undefined,
): Promise<BrowserView> {
  const revisionList = await revisions(sessionId, path, reference);
  const selectedRevision = revision ?? revisionList.head_revision;
  const referenceRevision = reference ?? revisionList.head_revision;
  const shown = RevisionShowResultSchema.parse(await callCommand({
    sessionId,
    command: ["rev-show", selectedRevision, path, "--reference", String(referenceRevision)],
  }));
  const tree = await readTree(sessionId, "/", "/", "", "open", selectedRevision);

  return {
    sessionId,
    currentPath: shown.details.view_path,
    selectedRevision: shown.details.revision,
    referenceRevision,
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
  revision: number,
): Promise<BrowserTreeEntry> {
  const listed = await list(sessionId, path, revision, revision);
  const children = await Promise.all(listed.entries.map(async (entry) => {
    const childPath = joinPath(listed.listedPath, entry.name);
    return readTree(sessionId, childPath, entry.name, entry.title, entry.status, revision);
  }));
  return { name, path: listed.listedPath, title, status, children };
}

async function list(sessionId: string, path: string, revision: number, reference: number) {
  return ListResultSchema.parse(await callCommand({
    sessionId,
    command: ["ls", path, "--revision", String(revision), "--reference", String(reference)],
  }));
}

async function revisions(sessionId: string, path: string, reference: number | undefined) {
  const command: (string | number)[] = ["rev-list", path];
  if (reference !== undefined) command.push("--reference", String(reference));
  return RevisionListResultSchema.parse(await callCommand({ sessionId, command }));
}

function joinPath(parent: string, name: string): string {
  const segment = escapePathSegment(name);
  return parent === "/" ? "/" + segment : parent + "/" + segment;
}

function escapePathSegment(name: string): string {
  const escaped = name.replaceAll("\\", "\\\\").replaceAll("/", "\\/");
  return escaped === "." || escaped === ".." ? "\\" + escaped : escaped;
}
