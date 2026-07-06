import { auth, db, canParticipate } from "./firebase-init.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

// Embedded client-side (same trust model as the OpenWeatherMap key in index.html), but this
// key is directly billable — unlike the weather key, a leaked/scraped copy can run up real
// cost. Once pushed, it's visible to anyone viewing the deployed site's source or browsing the
// public GitHub repo. Restrict/rotate it in the Alibaba Cloud DashScope console if this stays public.
const QWEN_API_KEY = "sk-ws-H.YPRIMR.D6ch.MEQCIFepSDGumKwff6nPeQ_r-8jjk9JkUkCxP4Xlcoj_kLRlAiAMQvXY--hDdBtYHNPC1AK7TUyplGrbPF1l0djz2jIcGA";
const QWEN_ENDPOINT = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const MODEL = "qwen3.5-omni-flash";

const SYSTEM_INSTRUCTION =
  "You are the core secretary of a personal system called Personal OS. Be sharp, efficient, and " +
  "minimalist — short replies, no filler. When the user's message describes spending money, buying " +
  "something, or logging an invoice/receipt, call the addExpense tool instead of just replying in text.";

const ADD_EXPENSE_TOOL = {
  type: "function",
  function: {
    name: "addExpense",
    description:
      "Log a financial expense. Call this whenever the user's message describes spending money, " +
      "buying something, or saving an invoice/receipt item.",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number", description: "The amount spent, as a plain number with no currency symbol." },
        category: {
          type: "string",
          enum: ["Food", "Transport", "Entertainment", "Shopping", "Utilities", "Others"],
          description: "The spending category.",
        },
        description: { type: "string", description: "A short description of what the expense was for." },
      },
      required: ["amount", "category", "description"],
    },
  },
};

// OpenAI-compatible chat history — the fetch() endpoint is stateless per-request, so (unlike the
// old SDK's `chat` session object) this array is what carries conversation context across turns.
const messages = [{ role: "system", content: SYSTEM_INSTRUCTION }];

const chatLog = document.getElementById("chat-log");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatSendBtn = document.getElementById("chat-send-btn");

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function appendMessage(role, text) {
  const row = document.createElement("div");
  row.className = `is-visible flex ${role === "user" ? "justify-end" : "justify-start"}`;
  const bubbleClass =
    role === "user"
      ? "bg-gradient-to-r from-neonViolet to-neonPurple text-white rounded-2xl rounded-br-sm"
      : "bg-darkBg/60 border border-borderNeon text-white rounded-2xl rounded-bl-sm";
  row.innerHTML = `<div class="max-w-[80%] ${bubbleClass} px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">${escapeHtml(text)}</div>`;
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
  return row;
}

function appendTyping() {
  const row = document.createElement("div");
  row.id = "typing-indicator";
  row.className = "is-visible flex justify-start";
  row.innerHTML = `<div class="bg-darkBg/60 border border-borderNeon text-textGray rounded-2xl rounded-bl-sm px-4 py-2.5 text-sm font-code">...</div>`;
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function removeTyping() {
  document.getElementById("typing-indicator")?.remove();
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Writes into the same `expenses` collection/schema used everywhere else in the app
// (`note`, not `description` — matches expenses.js/calendar.js/insights.js/dashboard.js).
async function handleAddExpense(args) {
  const user = auth.currentUser;
  if (!user || !canParticipate()) {
    throw new Error("not-authorized");
  }
  const amount = Number(args.amount) || 0;
  const category = String(args.category || "others").toLowerCase();
  const note = args.description || "";

  await addDoc(collection(db, "expenses"), {
    amount,
    category,
    note,
    uid: user.uid,
    createdAt: serverTimestamp(),
  });

  return { amount, category, note };
}

async function callQwen() {
  const res = await fetch(QWEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${QWEN_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: [ADD_EXPENSE_TOOL],
      tool_choice: "auto",
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Qwen API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data.choices[0].message;
}

async function handleAssistantMessage(message) {
  messages.push(message);
  const toolCalls = message.tool_calls;

  if (toolCalls && toolCalls.length) {
    for (const toolCall of toolCalls) {
      if (toolCall.function?.name !== "addExpense") continue;
      let args = {};
      try {
        args = JSON.parse(toolCall.function.arguments || "{}");
      } catch (err) {
        console.error("[ai-agent] failed to parse tool arguments:", err);
      }

      try {
        const result = await handleAddExpense(args);
        appendMessage("ai", `✅ Successfully logged RM ${result.amount.toFixed(2)} under ${capitalize(result.category)}.`);
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify({ status: "success", ...result }),
        });
      } catch (err) {
        console.error("[ai-agent] addExpense failed:", err);
        appendMessage("ai", "I couldn't save that expense — you may need to be an approved participant first.");
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify({ status: "error", message: String(err.message || err) }),
        });
      }
    }

    const followUp = await callQwen();
    messages.push(followUp);
    if (followUp.content && followUp.content.trim()) {
      appendMessage("ai", followUp.content.trim());
    }
    return;
  }

  if (message.content && message.content.trim()) {
    appendMessage("ai", message.content.trim());
  }
}

async function sendUserMessage(text) {
  appendMessage("user", text);
  messages.push({ role: "user", content: text });
  chatInput.value = "";
  chatInput.disabled = true;
  chatSendBtn.disabled = true;
  appendTyping();

  try {
    const message = await callQwen();
    removeTyping();
    await handleAssistantMessage(message);
  } catch (err) {
    console.error("[ai-agent] sendMessage failed:", err);
    removeTyping();
    appendMessage("ai", "Something went wrong talking to the model — check the console (a real Qwen API key needs to be set in ai-agent.js).");
  } finally {
    chatInput.disabled = false;
    chatSendBtn.disabled = false;
    chatInput.focus();
  }
}

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  sendUserMessage(text);
});

onAuthStateChanged(auth, (user) => {
  if (!user) return;
  appendMessage("ai", `Hi ${user.displayName ? user.displayName.split(" ")[0] : "there"} — what can I help with?`);
});
