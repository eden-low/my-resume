import { auth, db, canParticipate } from "./firebase-init.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { GoogleGenAI, Type, FunctionCallingConfigMode } from "https://cdn.jsdelivr.net/npm/@google/genai/+esm";

// Embedded client-side (same trust model as the OpenWeatherMap key in index.html), but this
// key is directly billable — unlike the weather key, a leaked/scraped copy can run up real
// cost. Once pushed, it's visible to anyone viewing the deployed site's source or browsing the
// public GitHub repo. Restrict it in Google Cloud Console (API restriction to Generative
// Language API, and/or HTTP referrer restriction to your own domain) if this stays public.
const GEMINI_API_KEY = "AQ.Ab8RN6KTGvUAsEvZ7p64JSZItqOQXPeoDPX2TFYmBznHR4VdPQ";
const MODEL = "gemini-2.5-flash";

const SYSTEM_INSTRUCTION =
  "You are the core secretary of a personal system called Personal OS. Be sharp, efficient, and " +
  "minimalist — short replies, no filler. When the user's message describes spending money, buying " +
  "something, or logging an invoice/receipt, call the addExpense tool instead of just replying in text.";

const ADD_EXPENSE_DECLARATION = {
  name: "addExpense",
  description:
    "Log a financial expense. Call this whenever the user's message describes spending money, " +
    "buying something, or saving an invoice/receipt item.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      amount: { type: Type.NUMBER, description: "The amount spent, as a plain number with no currency symbol." },
      category: {
        type: Type.STRING,
        enum: ["Food", "Transport", "Entertainment", "Shopping", "Utilities", "Others"],
        description: "The spending category.",
      },
      description: { type: Type.STRING, description: "A short description of what the expense was for." },
    },
    required: ["amount", "category", "description"],
  },
};

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const chat = ai.chats.create({
  model: MODEL,
  config: {
    systemInstruction: SYSTEM_INSTRUCTION,
    tools: [{ functionDeclarations: [ADD_EXPENSE_DECLARATION] }],
    toolConfig: {
      functionCallingConfig: {
        mode: FunctionCallingConfigMode.ANY,
      },
    },
  },
});

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

async function handleModelResponse(response) {
  removeTyping();
  const calls = response.functionCalls;

  if (calls && calls.length) {
    for (const call of calls) {
      if (call.name !== "addExpense") continue;
      try {
        const result = await handleAddExpense(call.args);
        appendMessage("ai", `✅ Successfully logged RM ${result.amount.toFixed(2)} under ${capitalize(result.category)}.`);

        const followUp = await chat.sendMessage({
          message: [{ functionResponse: { name: "addExpense", response: { status: "success", ...result } } }],
        });
        if (followUp.text && followUp.text.trim()) {
          appendMessage("ai", followUp.text.trim());
        }
      } catch (err) {
        console.error("[ai-agent] addExpense failed:", err);
        appendMessage("ai", "I couldn't save that expense — you may need to be an approved participant first.");
      }
    }
    return;
  }

  if (response.text && response.text.trim()) {
    appendMessage("ai", response.text.trim());
  }
}

async function sendUserMessage(text) {
  appendMessage("user", text);
  chatInput.value = "";
  chatInput.disabled = true;
  chatSendBtn.disabled = true;
  appendTyping();

  try {
    const response = await chat.sendMessage({ message: text });
    await handleModelResponse(response);
  } catch (err) {
    console.error("[ai-agent] sendMessage failed:", err);
    removeTyping();
    appendMessage("ai", "Something went wrong talking to the model — check the console (a real Gemini API key needs to be set in ai-agent.js).");
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
