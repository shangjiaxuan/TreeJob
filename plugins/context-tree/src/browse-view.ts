import type { EntrySummary, NodeRevisionSummary } from "./schema.js";
import type { BrowserTreeEntry, BrowserView } from "./browse-data.js";

export function renderLoginPage(message = ""): string {
  return documentPage(
    "Context Tree browser",
    "<main class=\"login\">" +
      "<h1>Context Tree browser</h1>" +
      "<p>Enter an existing local Context Tree session ID.</p>" +
      (message ? "<p class=\"error\">" + escapeHtml(message) + "</p>" : "") +
      "<form action=\"/login\" method=\"get\">" +
        "<label>Session ID <input name=\"sessionId\" required autofocus></label>" +
        "<button type=\"submit\">Browse</button>" +
      "</form>" +
    "</main>",
  );
}

export function renderBrowsePage(result: BrowserView): string {
  const currentPath = result.currentPath;
  const selectedRevisionId = result.selectedRevision.revisionId;
  const tree = renderTree(result.tree, currentPath);
  const revisions = result.revisions.map((revision) =>
    renderRevision(revision, currentPath, selectedRevisionId)
  ).join("");
  const entries = renderEntries(result.entries);
  const work = escapeHtml(JSON.stringify(result.work, null, 2));

  return documentPage(
    "Context Tree: " + currentPath,
    "<header>" +
      "<div><strong>Context Tree</strong> <span>" + escapeHtml(result.sessionId) + "</span></div>" +
      "<div>Session view · <a href=\"/logout\">change session</a></div>" +
    "</header>" +
    "<main class=\"browser\">" +
      "<aside class=\"tree-panel\"><h2>Workspace tree</h2><ul class=\"tree\">" + tree + "</ul></aside>" +
      "<section class=\"content\">" +
        "<p class=\"path\">" + escapeHtml(currentPath) + "</p>" +
        "<h1>" + escapeHtml(result.work.title || nameAtPath(currentPath)) + "</h1>" +
        "<p><span class=\"status\">" + escapeHtml(result.work.status) + "</span> " +
          "Revision " + selectedRevisionId + " · " + escapeHtml(result.selectedRevision.changes.join(", ")) + "</p>" +
        "<h2>Work</h2><pre>" + work + "</pre>" +
        "<h2>Children at this revision</h2>" + entries +
      "</section>" +
      "<aside class=\"revisions\"><h2>Revisions</h2><ol>" + revisions + "</ol></aside>" +
    "</main>",
  );
}

function renderTree(node: BrowserTreeEntry, currentPath: string): string {
  const children = node.children.length === 0
    ? ""
    : "<ul>" + node.children.map((child) => renderTree(child, currentPath)).join("") + "</ul>";
  const selected = node.path === currentPath ? " class=\"selected\"" : "";
  const label = node.name === "/" ? "/" : node.name;
  const detail = node.title ? " <small>" + escapeHtml(node.title) + "</small>" : "";

  return "<li" + selected + "><a href=\"" + browseUrl(node.path) + "\">" +
    escapeHtml(label) + "</a>" + detail + children + "</li>";
}

function renderRevision(
  revision: NodeRevisionSummary,
  path: string,
  selectedRevisionId: number,
): string {
  const selected = revision.revisionId === selectedRevisionId ? " class=\"selected\"" : "";
  return "<li" + selected + "><a href=\"" + browseUrl(path, revision.revisionId) + "\">" +
    "#" + revision.revisionId + "</a><br><small>" +
    escapeHtml(revision.changes.join(", ")) + "<br>" +
    escapeHtml(revision.createdAt) + "</small></li>";
}

function nameAtPath(path: string): string {
  if (path === "/") {
    return "/";
  }

  const segments = path.split("/");
  return segments[segments.length - 1] ?? path;
}

function renderEntries(entries: EntrySummary[]): string {
  if (entries.length === 0) {
    return "<p class=\"empty\">No child nodes.</p>";
  }

  return "<ul class=\"entries\">" + entries.map((entry) =>
    "<li><strong>" + escapeHtml(entry.name) + "</strong> " +
      "<span class=\"status\">" + escapeHtml(entry.status) + "</span> " +
      escapeHtml(entry.title || entry.kind) +
    "</li>"
  ).join("") + "</ul>";
}

function browseUrl(path: string, revisionId?: number): string {
  const encodedPath = path.split("/").map((segment) =>
    encodeURIComponent(segment)
  ).join("/");
  const query = revisionId === undefined ? "" : "?revision=" + revisionId;
  return "/browse" + (encodedPath || "/") + query;
}

function documentPage(title: string, body: string): string {
  return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    "<title>" + escapeHtml(title) + "</title><style>" +
    "*{box-sizing:border-box}body{margin:0;background:#fafafa;color:#222;font:14px system-ui,sans-serif}" +
    "header{height:48px;padding:14px 20px;display:flex;justify-content:space-between;background:#20242a;color:#f8f8f8}header span{color:#b9c2cc;margin-left:12px}a{color:#1463a5;text-decoration:none}header a{color:#d7eaff}" +
    ".browser{display:grid;grid-template-columns:minmax(210px,25%) minmax(360px,1fr) minmax(190px,22%);min-height:calc(100vh - 48px)}" +
    ".tree-panel,.revisions{padding:18px;background:#f0f2f4;border-right:1px solid #d7dce0;overflow:auto}.revisions{border-left:1px solid #d7dce0;border-right:0}" +
    ".content{padding:24px;overflow:auto}.path{color:#64707c;font-family:ui-monospace,monospace}.tree,.tree ul{margin:0;padding-left:18px;list-style:none}.tree li{margin:5px 0}.tree small{color:#65717c}.selected>a,.revisions .selected>a{font-weight:700;color:#b34a10}.revisions ol{padding-left:22px}.revisions li{margin:0 0 12px}.status{display:inline-block;padding:1px 6px;border-radius:8px;background:#e3e8ed;color:#44515c;font-size:12px}.entries{padding-left:20px}.entries li{margin:8px 0}pre{padding:14px;white-space:pre-wrap;word-break:break-word;background:#f1f3f5;border:1px solid #dce1e5;border-radius:4px}.empty{color:#6c7781}.login{max-width:420px;margin:12vh auto;padding:28px;background:#fff;border:1px solid #dce1e5;border-radius:6px}.login label{display:block;margin:18px 0}.login input{display:block;width:100%;margin-top:6px;padding:8px}.login button{padding:8px 14px}.error{color:#a42b20}@media(max-width:850px){.browser{grid-template-columns:1fr}.tree-panel,.revisions{border:0;border-bottom:1px solid #d7dce0}.revisions{order:3}}" +
    "</style></head><body>" + body + "</body></html>";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>\"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}
