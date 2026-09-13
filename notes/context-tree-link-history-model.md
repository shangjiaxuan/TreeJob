# Context Tree v6 — Link-History Views

Date: 2026-09-13

## Core distinction

`NodeId` is a stable logical continuation identity. `LinkId` is a stable named
placement that permanently targets one `NodeId`. They each have an independent
history stream, evaluated in the same explicit session revision view.

```text
Node history:  NodeId + { session, revision } -> WorkFields
Link history:  LinkId + { session, revision } -> { parent NodeId, name }
```

The generic resolver chooses the latest local history row at or before the
requested revision. If none exists, it follows the session's immutable fork
base. It never reads parent-session changes that happened after that fork.

## Frozen views, cheap updates

A public revision is a fixed `{ rootNodeId, sessionId, revision }` view rather
than a copied tree or an overlay chain. It is historically stable because node
and link history rows are immutable and every lookup is bounded by that view.

```text
edit / close  -> one node history row
mkdir         -> one node history row plus one link history row
move / rename -> one link history row
cd            -> cursor event only
```

Directory traversal lists effective links for a parent in the selected view;
then each link's stable child `NodeId` resolves through node history in that
same view. A node update therefore reaches all active placements without
rewriting parents. Multiple stable links may target one node internally, though
v6 exposes no public hard-link command.

The paired successor lookup returns the first later local node or link state.
It is branch-local and supports validity intervals, history comparison, and
diagnostics. It does not make a parent-session future state visible in a fork.
