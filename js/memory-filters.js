// EdenAtlas — shared predicate for excluding trashed Memories (photos) from every read
// surface. A Memory is "trashed" once it carries a deletedAt timestamp (the Move-to-Trash
// feature, see CLAUDE.md); a missing/null/undefined deletedAt always means active, including
// every legacy photos doc that predates this field — no migration was run or is needed.
//
// This is the single choke point every photos-consuming fetch helper across the app (gallery,
// atlas, global-search, profile, collections, collection-detail, insights, calendar, index,
// me, constellation) calls before handing results to its own caller, so "hide trashed
// Memories everywhere" only has one place to get right.

export function isDeleted(item) {
  return !!(item && item.deletedAt);
}

export function isActiveMemory(item) {
  return !isDeleted(item);
}

export function excludeDeleted(items) {
  return (items || []).filter(isActiveMemory);
}
