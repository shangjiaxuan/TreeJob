import { callQuery } from "../command-client.js";
import {
  ListResultSchema,
  RevisionListResultSchema,
  RevisionShowResultSchema,
  type CurrentWork,
  type EntrySummary,
  type RecordStatus,
  type RevisionSummary,
} from "../../protocol/schema.js";

export type BrowserTreeEntry = {
  name: string;
  path: string;
  title: string;
  status: RecordStatus;
  children: BrowserTreeEntry[];
};

export type BrowserNodeRevision = {
  sessionId: string;
  revision: number;
  createdAt: string;
};

export type BrowserView = {
  sessionId: string;
  currentPath: string;
  referencePath: string;
  headRevision: number;
  hasExplicitView: boolean;
  selectedRevision: RevisionSummary;
  referenceRevision: number;
  work: CurrentWork;
  entries: EntrySummary[];
  nodeRevisions: BrowserNodeRevision[];
  tree: BrowserTreeEntry;
};

export async function readBrowserView(
  sessionId: string,
  path: string,
  revision: number | undefined,
  reference: number | undefined,
): Promise<BrowserView> {
  if (revision === undefined && reference === undefined) {
    return readHeadBrowserView(sessionId, path);
  }

  const revisionList = await revisions(sessionId, path, reference);
  const selectedRevision = revision ?? revisionList.head_revision;
  const referenceRevision = reference ?? revisionList.head_revision;
  const shown = await showRevision(sessionId, path, selectedRevision, referenceRevision);
  const anchored = selectedRevision === referenceRevision
    ? shown
    : await showRevision(sessionId, path, referenceRevision, referenceRevision);
  const tree = await readTree(sessionId, "/", "/", "", "open", selectedRevision);

  return {
    sessionId,
    currentPath: shown.details.view_path,
    referencePath: anchored.details.view_path,
    headRevision: revisionList.head_revision,
    hasExplicitView: revision !== undefined || reference !== undefined,
    selectedRevision: shown.details.revision,
    referenceRevision,
    work: shown.details.work,
    entries: shown.details.entries,
    nodeRevisions: nodeRevisions(revisionList.revisions),
    tree,
  };
}

async function readHeadBrowserView(sessionId: string, path: string): Promise<BrowserView> {
  const shown = await showHead(sessionId, path);
  const revisionList = await revisions(sessionId, path, undefined);
  const tree = await readTree(sessionId, "/", "/", "", "open", undefined);

  return {
    sessionId,
    currentPath: shown.details.view_path,
    referencePath: shown.details.view_path,
    headRevision: shown.details.revision.revision,
    hasExplicitView: false,
    selectedRevision: shown.details.revision,
    referenceRevision: shown.details.revision.revision,
    work: shown.details.work,
    entries: shown.details.entries,
    nodeRevisions: nodeRevisions(revisionList.revisions),
    tree,
  };
}

async function showHead(sessionId: string, path: string) {
  return RevisionShowResultSchema.parse(await callQuery({
    sessionId,
    command: ["rev-show", path],
  }));
}

async function showRevision(sessionId: string, path: string, revision: number, reference: number) {
  return RevisionShowResultSchema.parse(await callQuery({
    sessionId,
    command: ["rev-show", revision, path, "--reference", String(reference)],
  }));
}

async function readTree(
  sessionId: string,
  path: string,
  name: string,
  title: string,
  status: RecordStatus,
  revision: number | undefined,
): Promise<BrowserTreeEntry> {
  const listed = await list(sessionId, path, revision, revision);
  const children = await Promise.all(listed.entries.map(async (entry) => {
    const childPath = joinPath(listed.listedPath, entry.name);
    return readTree(sessionId, childPath, entry.name, entry.title, entry.status, revision);
  }));
  return { name, path: listed.listedPath, title, status, children };
}

async function list(
  sessionId: string,
  path: string,
  revision: number | undefined,
  reference: number | undefined,
) {
  const command: string[] = ["ls", path];
  if (revision !== undefined) {
    command.push("--revision", String(revision));
  }
  if (reference !== undefined) {
    command.push("--reference", String(reference));
  }
  return ListResultSchema.parse(await callQuery({
    sessionId,
    command,
  }));
}

async function revisions(sessionId: string, path: string, reference: number | undefined) {
  const command: (string | number)[] = ["rev-list", path, "--verbose"];
  if (reference !== undefined) command.push("--reference", String(reference));
  return RevisionListResultSchema.parse(await callQuery({ sessionId, command }));
}

function nodeRevisions(revisions: RevisionSummary[]): BrowserNodeRevision[] {
  const rows = new Map<string, BrowserNodeRevision>();

  for (const revision of revisions) {
    const created = revision.created_view;
    if (created === undefined) continue;
    const key = created.sessionId + "\u0000" + created.revision;
    if (!rows.has(key)) {
      rows.set(key, {
        sessionId: created.sessionId,
        revision: created.revision,
        createdAt: revision.createdAt,
      });
    }
  }

  return [...rows.values()];
}

function joinPath(parent: string, name: string): string {
  const segment = escapePathSegment(name);
  return parent === "/" ? "/" + segment : parent + "/" + segment;
}

function escapePathSegment(name: string): string {
  const escaped = name.replaceAll("\\", "\\\\").replaceAll("/", "\\/");
  return escaped === "." || escaped === ".." ? "\\" + escaped : escaped;
}
