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
import { t } from "./js/i18n.js";

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

const consentModal = document.getElementById("assistant-consent-modal");
const consentBackdrop = document.getElementById("assistant-consent-backdrop");
const consentCheckbox = document.getElementById("assistant-consent-checkbox");
const consentAccept = document.getElementById("assistant-consent-accept");

// ---- State ----
let conversation = []; // [{ role: "user"|"assistant", content, sources?, ts }]
let currentController = null;
let lastUserMessage = null;
let thinkingTimer = null;

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
function esc(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
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
      formEl.requestSubmit();
    });
    promptsEl.appendChild(btn);
  });
}

function setScopeChecked(scope, checked) {
  const el = scopeInputs.find((s) => s.dataset.scope === scope);
  if (el) el.checked = checked;
  saveScopes(currentScopes());
}

function copyBtnHTML() {
  return `<button type="button" class="assistant-copy-btn text-[11px] text-textGray hover:text-white flex items-center gap-1 mt-2" aria-label="${t("assistant.copy_response") !== "assistant.copy_response" ? t("assistant.copy_response") : "Copy response"}">
    <i data-lucide="copy" class="w-3 h-3"></i><span data-i18n="assistant.copy_response">Copy response</span></button>`;
}

function sourceCardsHTML(sources) {
  if (!sources || !sources.length) return "";
  const chips = sources
    .filter((s) => SOURCE_PAGE[s.type])
    .map(
      (s) => `<a href="${SOURCE_PAGE[s.type]}" class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-darkBg/60 border border-borderNeon text-[11px] text-textGray hover:text-white hover:border-neonPurple/50 transition-colors">
        <i data-lucide="${SOURCE_ICON[s.type] || "file"}" class="w-3 h-3"></i>${esc(s.label || s.type)}
      </a>`
    )
    .join("");
  return chips ? `<div class="flex flex-wrap gap-1.5 mt-2">${chips}</div>` : "";
}

function bubbleHTML(msg) {
  const isUser = msg.role === "user";
  const align = isUser ? "ml-auto" : "mr-auto";
  const bg = isUser ? "bg-neonPurple/15 text-white" : "bg-darkBg/60 text-white";
  if (msg.pending) {
    return `<div class="max-w-[85%] ${align} ${bg} rounded-2xl px-4 py-3" aria-label="${t("assistant.thinking") !== "assistant.thinking" ? t("assistant.thinking") : "Thinking…"}">
      <span class="flex items-center gap-1"><span class="eden-typing-dot w-1.5 h-1.5 rounded-full bg-textGray inline-block"></span><span class="eden-typing-dot w-1.5 h-1.5 rounded-full bg-textGray inline-block"></span><span class="eden-typing-dot w-1.5 h-1.5 rounded-full bg-textGray inline-block"></span></span>
      <span class="assistant-thinking-phase text-xs text-textGray ml-2">${esc(msg.phase || "")}</span>
    </div>`;
  }
  const body = `<p class="text-sm whitespace-pre-wrap break-words">${esc(msg.content)}</p>`;
  const sources = isUser ? "" : sourceCardsHTML(msg.sources);
  const copy = isUser || msg.cancelled ? "" : copyBtnHTML();
  return `<div class="max-w-[85%] ${align} ${bg} rounded-2xl px-4 py-3">${body}${sources}${copy}</div>`;
}

function renderAll() {
  messagesEl.querySelectorAll(".assistant-bubble-row").forEach((el) => el.remove());
  emptyStateEl.classList.toggle("hidden", conversation.length > 0);
  conversation.forEach((msg, i) => {
    const row = document.createElement("div");
    row.className = "assistant-bubble-row flex";
    row.dataset.index = String(i);
    row.innerHTML = bubbleHTML(msg);
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
    const idToken = await user.getIdToken();
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ message: text, history: historyForServer, scopes }),
      signal: currentController.signal,
    });
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
    conversation[pendingIndex] = { role: "assistant", content: data.answer, sources: data.sources, ts: Date.now() };
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

function resetConversation() {
  conversation = [];
  sessionStorage.removeItem(CONVO_KEY);
  hideError();
  renderAll();
}
newChatBtn.addEventListener("click", resetConversation);
clearBtn.addEventListener("click", resetConversation);

scopeInputs.forEach((el) => el.addEventListener("change", () => saveScopes(currentScopes())));

// ---- Init ----
onAuthStateChanged(auth, (user) => {
  if (!user) return; // auth-guard.js owns the redirect for a signed-out visitor
  const savedScopes = loadScopes();
  scopeInputs.forEach((el) => { el.checked = savedScopes.includes(el.dataset.scope); });
  conversation = loadConversation();
  renderSuggestedPrompts();
  renderAll();
  if (!hasConsented()) openConsentModal();
});

document.addEventListener("eden:langchange", () => {
  renderSuggestedPrompts();
  renderAll();
});
