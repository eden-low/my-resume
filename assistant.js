// Atlas Assistant — Owner-only frontend for /.netlify/functions/assistant. Same
// per-page-duplication convention as every other page script in this repo (see
// CLAUDE.md) — no shared "chat widget" module, this is the only page that needs one.
//
// `auth-guard.js`'s `data-owner-only="true"` (see assistant.html's <body>) already redirects any
// non-owner away before this script's UI is ever usable; this file additionally never sends a
// request without a fresh, server-verified ID token, so even a direct API call bypassing the UI
// still has to pass the Function's own auth/owner checks (see netlify/functions/assistant.js).
import { auth } from "./firebase-init.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { t, getLang } from "./js/i18n.js";

const ENDPOINT = "/.netlify/functions/assistant";
const CONSENT_KEY = "eden:assistantConsent";
const SCOPES_KEY = "eden:assistantScopes";
const CONVO_KEY = "eden:assistantConversation"; // sessionStorage — cleared when the tab closes,
// never written to Firestore. This is the MVP's entire "persistence" story for chat history.

const MAX_HISTORY_ITEMS = 20;
const MAX_HISTORY_ITEM_LEN = 2000;

const SUGGESTED_PROMPTS = [
  { key: "assistant.prompt_missing_location", fallback: "Show my Memories that still need a confirmed location.", scope: "memories" },
  { key: "assistant.prompt_journey_summary", fallback: "Summarize my recent Journey.", scope: "journey" },
  { key: "assistant.prompt_this_month", fallback: "What did I record this month?", scope: "calendar" },
  { key: "assistant.prompt_draft_reflection", fallback: "Draft a monthly reflection from my selected sources.", scope: null },
  { key: "assistant.prompt_kampar", fallback: "Find Memories related to Kampar.", scope: "memories" },
];

const SOURCE_PAGE = { memory: "gallery.html", journal: "journal.html", journey: "timeline.html" };
const SOURCE_ICON = { memory: "image", journal: "book-open", journey: "compass" };

// t(key, vars) falls back to the raw key string when a translation is missing (see js/i18n.js) —
// this small helper mirrors the `t(key) !== key ? t(key) : fallback` pattern already used
// throughout this file, but also applies {placeholder} interpolation to the fallback text itself
// so a missing key never leaves a literal "{count}" on screen.
function tf(key, fallback, vars) {
  const val = t(key, vars);
  if (val !== key) return val;
  if (!vars) return fallback;
  return Object.keys(vars).reduce((s, k) => s.replaceAll(`{${k}}`, String(vars[k])), fallback);
}

// ---- DOM ----
const messagesEl = document.getElementById("assistant-messages");
const emptyStateEl = document.getElementById("assistant-empty-state");
const promptsEl = document.getElementById("assistant-suggested-prompts");
const formEl = document.getElementById("assistant-form");
const inputEl = document.getElementById("assistant-input");
const sendBtn = document.getElementById("assistant-send-btn");
const stopBtn = document.getElementById("assistant-stop-btn");
const newChatBtn = document.getElementById("assistant-new-chat");
const clearBtn = document.getElementById("assistant-clear-btn");
const errorBanner = document.getElementById("assistant-error-banner");
const errorText = document.getElementById("assistant-error-text");
const retryBtn = document.getElementById("assistant-retry-btn");
const scopeInputs = [...document.querySelectorAll('#assistant-scopes input[data-scope]')];
const scopeChangeNoticeEl = document.getElementById("assistant-scope-change-notice");
const noScopeNoticeEl = document.getElementById("assistant-noscope-notice");
const calendarScopeNoticeEl = document.getElementById("assistant-calendar-scope-notice");

const consentModal = document.getElementById("assistant-consent-modal");
const consentBackdrop = document.getElementById("assistant-consent-backdrop");
const consentCheckbox = document.getElementById("assistant-consent-checkbox");
const consentAccept = document.getElementById("assistant-consent-accept");

// ---- State ----
let conversation = []; // [{ role: "user"|"assistant", content, sources?, ts }]
let currentController = null;
let lastUserMessage = null;
let thinkingTimer = null;
let scopeNoticeTimer = null;
// The scope set as of the last time we actually acted on it — compared against on every change
// event so a change back to the SAME set (e.g. toggling a checkbox twice) never triggers a
// spurious reset. Seeded from localStorage at module load and re-seeded from the actual checkbox
// state once auth resolves (see onAuthStateChanged below) — programmatic `.checked` assignment
// never fires a "change" event, so this can never race the initial checkbox setup.
let lastScopesSnapshot = loadScopes();

function loadScopes() {
  try {
    const raw = localStorage.getItem(SCOPES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s) => ["memories", "journal", "journey", "calendar"].includes(s)) : [];
  } catch {
    return [];
  }
}

function saveScopes(scopes) {
  localStorage.setItem(SCOPES_KEY, JSON.stringify(scopes));
}

function currentScopes() {
  return scopeInputs.filter((el) => el.checked).map((el) => el.dataset.scope);
}

function sameScopeSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((s) => setA.has(s));
}

// Calendar is a date-organizing CAPABILITY, not a data grant of its own (mirrors
// netlify/functions/lib/tools.js's list_calendar/toolDefsForScopes). Two distinct predicates,
// deliberately not conflated (a hardening follow-up fixed a real bug where a single function did
// both jobs and wrongly disabled Send for Calendar+Journey too, even though Journey remains a
// fully independent, usable scope via list_journey):
//   - isCalendarOnlyScope: true ONLY when Calendar is the entire selected scope set — nothing
//     else is enabled, so no tool this request could offer would ever have anything to read
//     (list_calendar is never even offered in this state, and draft_reflection has nothing prior
//     to draft from). This is the one case that must never reach the network at all — see the
//     submit guard below and netlify/functions/assistant.js's matching server-side reject.
//   - calendarLacksSource: true whenever Calendar is enabled but neither Memories nor Journal is
//     — regardless of Journey. This only ever drives the non-blocking "Calendar also needs a
//     source" notice; it must NEVER by itself disable Send, since Journey (or any other scope)
//     may still make the request fully usable.
// Both are pure, DOM-free predicates (duplicated into the test suite, per this repo's own
// withOneRetryOn401/stripInlineMarkdown convention) so they're unit-testable without a browser.
function isCalendarOnlyScope(scopes) {
  return scopes.length === 1 && scopes[0] === "calendar";
}
function calendarLacksSource(scopes) {
  return scopes.includes("calendar") && !scopes.includes("memories") && !scopes.includes("journal");
}

// Scope selection is a privacy boundary, not just a UI preference: a disabled scope must never
// keep sending old answers containing that scope's data back to Qwen, and a newly-enabled scope
// must never be shadowed by an earlier "I don't have access" answer still sitting in history. So
// ANY actual change to the selected scope set — from a checkbox, or from a suggested prompt that
// auto-enables one (see renderSuggestedPrompts()) — resets the conversation exactly like New
// Chat, then shows a short, accessible notice. New Chat itself is unaffected: it never calls this
// function, so it never touches the scope checkboxes, only the conversation (see
// resetConversation()) — "New Chat preserves the currently selected scopes."
function applyScopeChange(newScopes) {
  saveScopes(newScopes);
  const changed = !sameScopeSet(lastScopesSnapshot, newScopes);
  lastScopesSnapshot = newScopes;
  if (changed) {
    resetConversation();
    showScopeChangeNotice();
  }
  updateSendAvailability();
  return changed;
}

function showScopeChangeNotice() {
  if (!scopeChangeNoticeEl) return;
  scopeChangeNoticeEl.classList.remove("hidden");
  clearTimeout(scopeNoticeTimer);
  scopeNoticeTimer = setTimeout(() => scopeChangeNoticeEl.classList.add("hidden"), 4000);
}

// Zero scopes selected => nothing this page could ask Qwen would ever be backed by real evidence
// (draft_reflection has no data scope of its own, but with no prior scoped search this turn it
// would have nothing to draft from either) — so Send is disabled outright rather than spending a
// request just to have the model explain that. See the submit handler below for the matching
// server-request guard (defense in depth beyond just disabling the button).
function updateSendAvailability() {
  const scopes = currentScopes();
  const hasScopes = scopes.length > 0;
  const calendarOnly = isCalendarOnlyScope(scopes);
  // The notice shows whenever Calendar lacks its own source — including Calendar+Journey, where
  // it's purely informational (Journey stays fully usable) — but Send is only ever disabled by
  // the strictly narrower calendarOnly case (see isCalendarOnlyScope's own comment).
  const needsCalendarSource = calendarLacksSource(scopes);
  sendBtn.disabled = !hasScopes || calendarOnly;
  if (noScopeNoticeEl) noScopeNoticeEl.classList.toggle("hidden", hasScopes);
  if (calendarScopeNoticeEl) calendarScopeNoticeEl.classList.toggle("hidden", !needsCalendarSource);
}

function loadConversation() {
  try {
    const raw = sessionStorage.getItem(CONVO_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveConversation() {
  try {
    sessionStorage.setItem(CONVO_KEY, JSON.stringify(conversation));
  } catch {
    // sessionStorage full/unavailable — conversation just won't survive a reload; not fatal.
  }
}

// ---- Rendering ----
//
// Task F: model output is ALWAYS untrusted — never assigned to innerHTML/insertAdjacentHTML,
// even escaped. Every function below builds real DOM nodes (createElement/textContent/
// appendChild) so a string like "<img onerror=alert(1)>" or "<script>...</script>" can only ever
// end up as literal, inert text content — there is no code path here that parses it as markup at
// all, escaped or otherwise. The only Markdown support is deliberately minimal (task F: "do not
// add broad raw-HTML Markdown support"): paragraphs, single-level bullet/numbered lists, and
// stripping (not styling) **bold**/*italic*/`code` decorations so the raw asterisks/backticks
// the model sometimes emits don't show up as literal punctuation in the chat.

// Strips the delimiter characters for a small, safe set of inline Markdown decorations, keeping
// the inner text as plain text — never converts them into real <strong>/<em>/<code> elements
// (simpler and equally sufficient for "make it readable," per task F's explicit "harmless
// decorations" framing rather than a styled rendering).
function stripInlineMarkdown(str) {
  return String(str || "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(^|[\s(])\*([^\s*][^*]*?)\*(?=[\s).,!?;:]|$)/g, "$1$2")
    .replace(/(^|[\s(])_([^\s_][^_]*?)_(?=[\s).,!?;:]|$)/g, "$1$2");
}

// Parses a small, safe subset of Markdown structure — blank-line-separated paragraphs and
// single-level "-"/"*"/"1." lists — directly into DOM nodes appended to `container`. No nested
// lists, no headings, no tables, no links, no raw HTML passthrough of any kind.
function renderAnswerBody(container, text) {
  container.replaceChildren();
  const lines = String(text || "").split(/\r?\n/);
  let currentList = null; // { el, ordered }
  let paragraphLines = [];

  function flushParagraph() {
    if (!paragraphLines.length) return;
    const p = document.createElement("p");
    p.className = "text-sm whitespace-pre-wrap break-words";
    p.textContent = stripInlineMarkdown(paragraphLines.join(" "));
    container.appendChild(p);
    paragraphLines = [];
  }
  function flushList() {
    if (currentList) { container.appendChild(currentList.el); currentList = null; }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) { flushParagraph(); flushList(); continue; }
    const bulletMatch = /^[-*]\s+(.*)$/.exec(line);
    const numberedMatch = /^\d+[.)]\s+(.*)$/.exec(line);
    if (bulletMatch || numberedMatch) {
      flushParagraph();
      const ordered = !!numberedMatch;
      if (!currentList || currentList.ordered !== ordered) {
        flushList();
        const el = document.createElement(ordered ? "ol" : "ul");
        el.className = ordered ? "list-decimal pl-5 text-sm space-y-1" : "list-disc pl-5 text-sm space-y-1";
        currentList = { el, ordered };
      }
      const li = document.createElement("li");
      li.textContent = stripInlineMarkdown((bulletMatch || numberedMatch)[1]);
      currentList.el.appendChild(li);
    } else {
      flushList();
      paragraphLines.push(line);
    }
  }
  flushParagraph();
  flushList();

  if (!container.childNodes.length) {
    container.appendChild(document.createElement("p")).className = "text-sm whitespace-pre-wrap break-words";
  }
}

// gallery.html?memory=<id> / journal.html?entry=<id> / timeline.html?event=<id> — each target
// page resolves the id only against its own already-fetched, already-authorized data (see
// gallery.js/journal.js/timeline.js's maybeFocus*FromQuery(), added alongside this), mirroring
// atlas.js's pre-existing ?memory= deep link. The Assistant never renders a raw id as visible
// text anywhere — only as this URL parameter.
const SOURCE_QUERY_PARAM = { memory: "memory", journal: "entry", journey: "event" };

function buildSourceChips(sources) {
  const wrap = document.createElement("div");
  wrap.className = "flex flex-wrap gap-1.5 mt-2";
  sources
    .filter((s) => SOURCE_PAGE[s.type] && SOURCE_QUERY_PARAM[s.type])
    .forEach((s) => {
      const a = document.createElement("a");
      a.href = `${SOURCE_PAGE[s.type]}?${SOURCE_QUERY_PARAM[s.type]}=${encodeURIComponent(s.id)}`;
      a.className = "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-darkBg/60 border border-borderNeon text-[11px] text-textGray hover:text-white hover:border-neonPurple/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neonPurple";
      const label = s.label || s.type;
      const openLabel = t("assistant.open_source") !== "assistant.open_source" ? t("assistant.open_source") : "Open";
      a.setAttribute("aria-label", `${openLabel}: ${label}`);
      const icon = document.createElement("i");
      icon.setAttribute("data-lucide", SOURCE_ICON[s.type] || "file");
      icon.className = "w-3 h-3";
      a.appendChild(icon);
      a.appendChild(document.createTextNode(label));
      wrap.appendChild(a);
    });
  return wrap;
}

// ---- Evidence row (trust/provenance pass) ----
//
// Renders ONLY from `msg.provenance` — the server's own non-model-controlled summary (see
// netlify/functions/lib/qwen.js's createProvenanceTracker) of which real tool(s) actually ran
// this turn, never from `msg.content` (the model's free-text answer). This is what makes it safe
// to treat this row as evidence rather than just more model output: every word in it traces back
// to a Firestore query this exact request executed and Firebase Admin already scoped to the
// Owner's own uid.

const EN_MONTHS = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function parseYmd(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ""));
  if (!m) return null;
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
}

// Formats a server-resolved "YYYY-MM-DD" start/end pair as a short human range — entirely via
// string/number formatting, NEVER via `new Date(v)`. Those strings already name a specific
// Asia/Kuala_Lumpur local calendar day (see lib/date-utils.js); re-parsing "YYYY-MM-DD" with the
// Date constructor anchors to UTC midnight, which could silently display the wrong day in a
// browser running in a different time zone — exactly the class of bug this whole feature exists
// to prevent, so this function is deliberately Date-object-free.
function formatSearchedRange(startDate, endDate, lang) {
  const start = parseYmd(startDate);
  const end = parseYmd(endDate);
  if (!start || !end) return `${startDate} – ${endDate}`;
  const isZh = lang === "zh-CN";
  if (start.y === end.y && start.mo === end.mo) {
    if (isZh) return start.d === end.d ? `${start.y}年${start.mo}月${start.d}日` : `${start.y}年${start.mo}月${start.d}–${end.d}日`;
    const month = EN_MONTHS[start.mo] || String(start.mo);
    return start.d === end.d ? `${start.d} ${month} ${start.y}` : `${start.d}–${end.d} ${month} ${start.y}`;
  }
  if (isZh) return `${start.y}年${start.mo}月${start.d}日 – ${end.y}年${end.mo}月${end.d}日`;
  const sMonth = EN_MONTHS[start.mo] || String(start.mo);
  const eMonth = EN_MONTHS[end.mo] || String(end.mo);
  return `${start.d} ${sMonth} ${start.y} – ${end.d} ${eMonth} ${end.y}`;
}

const SOURCE_GROUP_LABEL_KEY = { memories: "assistant.scope_memories", journal: "assistant.scope_journal", journey: "assistant.scope_journey" };

function sourceGroupLabel(group) {
  const key = SOURCE_GROUP_LABEL_KEY[group];
  if (!key) return group;
  const label = t(key);
  return label !== key ? label : group;
}

// Only ever called when `msg.provenance.toolsUsed.length > 0` (see buildBubble) — i.e. at least
// one real personal-data tool executed successfully this turn. A turn with no such tool call
// never reaches here, so this row can never appear for an answer that was only ever conversation
// context/model prose (task: "do not render the row when no personal-data tool ran").
function buildEvidenceRow(msg) {
  const prov = msg.provenance;
  const lang = getLang();
  const wrap = document.createElement("div");
  wrap.className = "assistant-evidence-row mt-2 pt-2 border-t border-borderNeon/40 space-y-1.5";
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", tf("assistant.evidence_label", "Evidence"));

  if (Array.isArray(prov.resolvedRanges) && prov.resolvedRanges.length) {
    const p = document.createElement("p");
    p.className = "text-[11px] text-textGray";
    const ranges = prov.resolvedRanges.map((r) => formatSearchedRange(r.startDate, r.endDate, lang)).join("; ");
    p.textContent = `${tf("assistant.evidence_searched", "Searched")}: ${ranges}`;
    wrap.appendChild(p);
  }

  const sourcesLine = document.createElement("p");
  sourcesLine.className = "text-[11px] text-textGray";
  const groupNames = (prov.includedSources || []).map(sourceGroupLabel).join(lang === "zh-CN" ? "、" : ", ");
  const sourcesLabel = tf("assistant.evidence_sources", "Sources");
  sourcesLine.textContent = groupNames ? `${sourcesLabel}: ${groupNames}` : sourcesLabel;
  wrap.appendChild(sourcesLine);

  if (!prov.resultCount) {
    const zero = document.createElement("p");
    zero.className = "text-[11px] text-textGray";
    zero.textContent = tf("assistant.evidence_zero_results", "0 matching records");
    wrap.appendChild(zero);
  } else if (prov.sourceCount) {
    const countLine = document.createElement("p");
    countLine.className = "text-[11px] text-textGray";
    countLine.textContent = tf("assistant.evidence_source_count", "{count} sources", { count: prov.sourceCount });
    wrap.appendChild(countLine);
    if (msg.sources && msg.sources.length) wrap.appendChild(buildSourceChips(msg.sources));
  }
  return wrap;
}

function buildCopyButton() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "assistant-copy-btn text-[11px] text-textGray hover:text-white flex items-center gap-1 mt-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neonPurple rounded";
  const label = t("assistant.copy_response") !== "assistant.copy_response" ? t("assistant.copy_response") : "Copy response";
  btn.setAttribute("aria-label", label);
  const icon = document.createElement("i");
  icon.setAttribute("data-lucide", "copy");
  icon.className = "w-3 h-3";
  const span = document.createElement("span");
  span.dataset.i18n = "assistant.copy_response";
  span.textContent = label;
  btn.appendChild(icon);
  btn.appendChild(span);
  return btn;
}

function buildBubble(msg) {
  const isUser = msg.role === "user";
  const wrapper = document.createElement("div");
  wrapper.className = `max-w-[85%] ${isUser ? "ml-auto" : "mr-auto"} ${isUser ? "bg-neonPurple/15 text-white" : "bg-darkBg/60 text-white"} rounded-2xl px-4 py-3`;

  if (msg.pending) {
    wrapper.setAttribute("aria-label", t("assistant.thinking") !== "assistant.thinking" ? t("assistant.thinking") : "Thinking…");
    const dots = document.createElement("span");
    dots.className = "flex items-center gap-1";
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement("span");
      dot.className = "eden-typing-dot w-1.5 h-1.5 rounded-full bg-textGray inline-block";
      dots.appendChild(dot);
    }
    const phase = document.createElement("span");
    phase.className = "assistant-thinking-phase text-xs text-textGray ml-2";
    phase.textContent = msg.phase || "";
    wrapper.appendChild(dots);
    wrapper.appendChild(phase);
    return wrapper;
  }

  const body = document.createElement("div");
  if (isUser) {
    const p = document.createElement("p");
    p.className = "text-sm whitespace-pre-wrap break-words";
    p.textContent = msg.content; // the Owner's own typed text — plain text content, no markdown parsing needed
    body.appendChild(p);
  } else {
    renderAnswerBody(body, msg.content); // untrusted model output — see renderAnswerBody()'s own comment
  }
  wrapper.appendChild(body);

  if (!isUser && msg.provenance && Array.isArray(msg.provenance.toolsUsed) && msg.provenance.toolsUsed.length) {
    wrapper.appendChild(buildEvidenceRow(msg));
  } else if (!isUser && msg.sources && msg.sources.length) {
    // Back-compat only: a conversation restored from sessionStorage that predates this pass
    // could carry `sources` with no `provenance` at all — still render its chips rather than
    // silently dropping them, but never fabricate an evidence row/searched-range for it.
    wrapper.appendChild(buildSourceChips(msg.sources));
  }
  if (!isUser && !msg.cancelled) {
    wrapper.appendChild(buildCopyButton());
  }
  return wrapper;
}

function renderSuggestedPrompts() {
  promptsEl.replaceChildren();
  SUGGESTED_PROMPTS.forEach((p) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "px-3 py-2 min-h-[36px] rounded-xl bg-darkBg/60 border border-borderNeon text-xs text-textGray hover:text-white hover:border-neonPurple/50 transition-colors";
    btn.textContent = t(p.key) !== p.key ? t(p.key) : p.fallback;
    btn.addEventListener("click", () => {
      if (p.scope) setScopeChecked(p.scope, true);
      inputEl.value = btn.textContent;
      inputEl.focus();
      // The Calendar-scoped suggested prompt ("What did I record this month?") must never
      // silently auto-send once Calendar is enabled if its own dependency (Memories and/or
      // Journal) still isn't — even when the overall scope set is otherwise usable (e.g. Journey
      // was already enabled, so Send itself stays enabled). The calendar notice is already
      // visible (via setScopeChecked -> applyScopeChange -> updateSendAvailability above); this
      // just leaves the typed question in the composer instead of spending a request on it.
      // Deliberately scoped to p.scope === "calendar" only — an unrelated suggested prompt (e.g.
      // Journey's) must still auto-submit normally even while Calendar happens to lack a source.
      if (p.scope === "calendar" && calendarLacksSource(currentScopes())) return;
      formEl.requestSubmit();
    });
    promptsEl.appendChild(btn);
  });
}

function setScopeChecked(scope, checked) {
  const el = scopeInputs.find((s) => s.dataset.scope === scope);
  if (el) el.checked = checked;
  applyScopeChange(currentScopes());
}

function renderAll() {
  messagesEl.querySelectorAll(".assistant-bubble-row").forEach((el) => el.remove());
  emptyStateEl.classList.toggle("hidden", conversation.length > 0);
  conversation.forEach((msg, i) => {
    const row = document.createElement("div");
    row.className = "assistant-bubble-row flex";
    row.dataset.index = String(i);
    row.appendChild(buildBubble(msg));
    messagesEl.appendChild(row);
  });
  if (window.lucide) window.lucide.createIcons();
  messagesEl.scrollTop = messagesEl.scrollHeight;
  wireCopyButtons();
}

function wireCopyButtons() {
  messagesEl.querySelectorAll(".assistant-copy-btn").forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = "1";
    btn.addEventListener("click", async () => {
      const row = btn.closest(".assistant-bubble-row");
      const idx = Number(row?.dataset.index);
      const msg = conversation[idx];
      if (!msg) return;
      try {
        await navigator.clipboard.writeText(msg.content);
        const label = btn.querySelector("span");
        const original = label.textContent;
        label.textContent = t("common.copied") !== "common.copied" ? t("common.copied") : "Copied!";
        setTimeout(() => { label.textContent = original; }, 1500);
      } catch {
        // Clipboard API can be denied/unavailable — silently no-op rather than throwing; the
        // user can still select the text manually.
      }
    });
  });
}

function showError(message) {
  errorText.textContent = message;
  errorBanner.classList.remove("hidden");
}

function hideError() {
  errorBanner.classList.add("hidden");
}

const THINKING_PHASES = () => [
  t("assistant.phase_thinking") !== "assistant.phase_thinking" ? t("assistant.phase_thinking") : "Thinking…",
  t("assistant.phase_searching") !== "assistant.phase_searching" ? t("assistant.phase_searching") : "Looking through your notes…",
  t("assistant.phase_composing") !== "assistant.phase_composing" ? t("assistant.phase_composing") : "Composing an answer…",
];

function startThinkingAnimation(pendingIndex) {
  const phases = THINKING_PHASES();
  let i = 0;
  conversation[pendingIndex].phase = phases[0];
  renderAll();
  thinkingTimer = setInterval(() => {
    i = (i + 1) % phases.length;
    if (!conversation[pendingIndex] || !conversation[pendingIndex].pending) { clearInterval(thinkingTimer); return; }
    conversation[pendingIndex].phase = phases[i];
    const row = messagesEl.querySelector(`.assistant-bubble-row[data-index="${pendingIndex}"] .assistant-thinking-phase`);
    if (row) row.textContent = phases[i];
  }, 2200);
}

function stopThinkingAnimation() {
  if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
}

// ---- Networking ----

// A 401 from /.netlify/functions/assistant almost always means the cached ID token `user.
// getIdToken()` returned was stale/near-expiry at the moment it was read, not that the session
// is genuinely invalid — Firebase's own token cache can lag behind a very recent sign-in or a
// clock-skew edge case. Exactly ONE retry, with a forced refresh (`getIdToken(true)`, which
// always fetches a brand-new token from Firebase rather than trusting the local cache): if the
// retry ALSO comes back 401, the session really is invalid and that is surfaced as a normal
// error by the caller — never a second retry, never a loop. `attempt(forceRefresh)` is injected
// so this policy is a small, pure function with no DOM/Firebase dependency of its own; the
// caller supplies the actual fetch+token logic. This exact function is duplicated (per this
// repo's own established per-file convention — see e.g. gallery.js's/assistant.js's
// trapFocus()) into the test suite to verify the retry-exactly-once behavior without needing a
// browser/DOM/Firebase environment — keep both copies in sync if this changes.
async function withOneRetryOn401(attempt) {
  let res = await attempt(false);
  if (res.status === 401) {
    res = await attempt(true);
  }
  return res;
}

function friendlyError(code) {
  const map = {
    assistant_not_configured: "assistant.error_not_configured",
    owner_only: "assistant.error_owner_only",
    invalid_or_expired_token: "assistant.error_session",
    missing_bearer_token: "assistant.error_session",
    origin_not_allowed: "assistant.error_origin",
    rate_limited: "assistant.error_rate_limited",
    message_too_long: "assistant.error_message_too_long",
    assistant_upstream_error: "assistant.error_upstream",
    // Defense-in-depth only — the submit guard/disabled Send already prevent this combination
    // from ever being sent through the UI (see isCalendarOnlyScope()); this only surfaces if a
    // request somehow reaches the server directly with Calendar as the sole scope.
    calendar_requires_memories_or_journal_scope: "assistant.calendar_needs_source_notice",
  };
  const key = map[code] || "assistant.error_generic";
  return t(key) !== key ? t(key) : "Something went wrong. Please try again.";
}

async function sendMessage(text) {
  hideError();
  lastUserMessage = text;
  const scopes = currentScopes();
  const historyForServer = conversation
    .filter((m) => !m.pending && !m.cancelled)
    .slice(-MAX_HISTORY_ITEMS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_HISTORY_ITEM_LEN) }));

  conversation.push({ role: "user", content: text, ts: Date.now() });
  const pendingIndex = conversation.length;
  conversation.push({ role: "assistant", content: "", pending: true, ts: Date.now() });
  saveConversation();
  renderAll();
  startThinkingAnimation(pendingIndex);

  sendBtn.classList.add("hidden");
  stopBtn.classList.remove("hidden");
  inputEl.disabled = true;

  currentController = new AbortController();
  try {
    const user = auth.currentUser;
    if (!user) throw new Error("not_signed_in");
    const res = await withOneRetryOn401(async (forceRefresh) =>
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${await user.getIdToken(forceRefresh)}` },
        body: JSON.stringify({ message: text, history: historyForServer, scopes }),
        signal: currentController.signal,
      })
    );
    const data = await res.json().catch(() => ({}));
    stopThinkingAnimation();
    if (!res.ok || !data.ok) {
      conversation.splice(pendingIndex, 1);
      if (res.status === 429) {
        showError(t("assistant.error_rate_limited") !== "assistant.error_rate_limited" ? t("assistant.error_rate_limited") : "You've hit the usage limit for now — try again later.");
      } else {
        showError(friendlyError(data.error));
      }
      renderAll();
      return;
    }
    conversation[pendingIndex] = { role: "assistant", content: data.answer, sources: data.sources, provenance: data.provenance, ts: Date.now() };
    saveConversation();
    renderAll();
  } catch (err) {
    stopThinkingAnimation();
    if (err && err.name === "AbortError") {
      conversation[pendingIndex] = { role: "assistant", content: t("assistant.cancelled") !== "assistant.cancelled" ? t("assistant.cancelled") : "Cancelled.", cancelled: true, ts: Date.now() };
      saveConversation();
      renderAll();
    } else {
      conversation.splice(pendingIndex, 1);
      showError(t("assistant.error_network") !== "assistant.error_network" ? t("assistant.error_network") : "Couldn't reach the assistant — check your connection.");
      renderAll();
    }
  } finally {
    currentController = null;
    sendBtn.classList.remove("hidden");
    stopBtn.classList.add("hidden");
    inputEl.disabled = false;
    inputEl.focus();
  }
}

// ---- Consent ----
function trapFocus(modalEl, onEscape) {
  function handleKeydown(e) {
    if (e.key === "Escape") { e.preventDefault(); onEscape(); return; }
    if (e.key !== "Tab") return;
    const items = [...modalEl.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  modalEl.addEventListener("keydown", handleKeydown);
  return () => modalEl.removeEventListener("keydown", handleKeydown);
}

function hasConsented() {
  return localStorage.getItem(CONSENT_KEY) === "1";
}

function openConsentModal() {
  consentModal.classList.remove("hidden");
  const untrap = trapFocus(consentModal, () => { /* Escape does not grant consent — modal stays open */ });
  consentCheckbox.focus();
  consentCheckbox._untrap = untrap;
}

function closeConsentModal() {
  consentModal.classList.add("hidden");
  if (consentCheckbox._untrap) consentCheckbox._untrap();
}

consentCheckbox.addEventListener("change", () => {
  consentAccept.disabled = !consentCheckbox.checked;
});
consentAccept.addEventListener("click", () => {
  if (!consentCheckbox.checked) return;
  localStorage.setItem(CONSENT_KEY, "1");
  closeConsentModal();
  inputEl.focus();
});
// Deliberately no backdrop-click-to-close and no consent granted on Escape — accepting sends
// data to a third-party service, so it needs an explicit, unambiguous action, not an accidental
// dismiss. The backdrop element still exists for visual dimming only.
consentBackdrop.addEventListener("click", () => {});

// ---- Wiring ----
formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!hasConsented()) { openConsentModal(); return; }
  // Defense in depth alongside sendBtn.disabled (updateSendAvailability()): this is the one
  // place that actually calls sendMessage(), so it's the authoritative gate regardless of how
  // submission was triggered (Send click, Enter key, or a suggested prompt's requestSubmit()) —
  // never spend a request just to have the model explain that no scopes are enabled, and never
  // spend one on a Calendar-ONLY selection that can never produce anything (see
  // isCalendarOnlyScope()) — the calendar notice stays visible instead so the Owner sees exactly
  // why nothing was sent. Deliberately NOT gated on calendarLacksSource() here — Calendar+Journey
  // (or any other non-empty combination) must stay fully sendable; only the exact "Calendar and
  // nothing else" state is ever blocked.
  const activeScopes = currentScopes();
  if (activeScopes.length === 0) return;
  if (isCalendarOnlyScope(activeScopes)) return;
  const text = inputEl.value.trim();
  if (!text || currentController) return;
  inputEl.value = "";
  inputEl.style.height = "auto";
  sendMessage(text);
});

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    formEl.requestSubmit();
  }
});
inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 128) + "px";
});

stopBtn.addEventListener("click", () => {
  if (currentController) currentController.abort();
});

retryBtn.addEventListener("click", () => {
  hideError();
  if (lastUserMessage) sendMessage(lastUserMessage);
});

// Task I: New Chat / Clear must reset EVERYTHING idempotently — conversation, any in-flight
// request, the pending/thinking indicator, the error banner, and sessionStorage — in one
// synchronous call, safe to invoke repeatedly (e.g. a fast double-click) with no partial state
// left over. Aborting any in-flight request here also matters for date correctness: an in-flight
// response that later resolves after a New Chat click must never land in the fresh, empty
// conversation — aborting it means sendMessage()'s own AbortError branch simply no-ops into a
// conversation array that's already been replaced.
function resetConversation() {
  if (currentController) {
    currentController.abort();
    currentController = null;
  }
  stopThinkingAnimation();
  conversation = [];
  lastUserMessage = null;
  sessionStorage.removeItem(CONVO_KEY);
  hideError();
  sendBtn.classList.remove("hidden");
  stopBtn.classList.add("hidden");
  inputEl.disabled = false;
  renderAll();
}
newChatBtn.addEventListener("click", resetConversation);
clearBtn.addEventListener("click", resetConversation);

scopeInputs.forEach((el) => el.addEventListener("change", () => applyScopeChange(currentScopes())));

// ---- Init ----
onAuthStateChanged(auth, (user) => {
  if (!user) return; // auth-guard.js owns the redirect for a signed-out visitor
  const savedScopes = loadScopes();
  scopeInputs.forEach((el) => { el.checked = savedScopes.includes(el.dataset.scope); });
  // Programmatic `.checked` assignment above never fires a "change" event, so this re-seed is
  // the only place lastScopesSnapshot needs to reflect reality before any user interaction —
  // reading it back from the checkboxes themselves (not `savedScopes`) so it's exactly what
  // applyScopeChange() will next compare against, even if the two ever drifted.
  lastScopesSnapshot = currentScopes();
  updateSendAvailability();
  conversation = loadConversation();
  renderSuggestedPrompts();
  renderAll();
  if (!hasConsented()) openConsentModal();
});

document.addEventListener("eden:langchange", () => {
  renderSuggestedPrompts();
  renderAll();
});
