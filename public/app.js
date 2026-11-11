const thread = document.querySelector("#thread");
const composer = document.querySelector("#composer");
const input = document.querySelector("#messageInput");
const clearButton = document.querySelector("#clearButton");
const title = document.querySelector("#conversationTitle");
let messages = [];
let busy = false;

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}

function renderMessage(message, sources = []) {
  const row = document.createElement("div");
  row.className = `message ${message.role}`;
  const avatar = message.role === "assistant" ? '<div class="avatar">✳</div>' : "";
  row.innerHTML = `${avatar}<div class="bubble">${escapeHtml(message.content)}</div>`;
  thread.appendChild(row);
  if (sources.length) {
    const sourceRow = document.createElement("div");
    sourceRow.className = "sources";
    sourceRow.innerHTML = sources.map((source) => `<a class="source" href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer"><b>[${source.id}]</b>${escapeHtml(source.title)}</a>`).join("");
    thread.appendChild(sourceRow);
  }
  thread.scrollTop = thread.scrollHeight;
}

function removeWelcome() {
  document.querySelector(".welcome")?.remove();
}

async function send(content) {
  if (busy || !content.trim()) return;
  busy = true;
  removeWelcome();
  const userMessage = { role: "user", content: content.trim() };
  messages.push(userMessage);
  renderMessage(userMessage);
  title.textContent = messages.length === 1 ? content.trim().slice(0, 32) : "Research in progress";
  input.value = "";
  input.style.height = "auto";
  const loading = document.createElement("div");
  loading.className = "message assistant";
  loading.innerHTML = '<div class="avatar">✳</div><div class="bubble typing">Searching the web…</div>';
  thread.appendChild(loading);
  thread.scrollTop = thread.scrollHeight;
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
      signal: AbortSignal.timeout(55000)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Request failed.");
    loading.remove();
    const assistantMessage = { role: "assistant", content: data.answer };
    messages.push(assistantMessage);
    renderMessage(assistantMessage, data.sources);
    title.textContent = "Research complete";
  } catch (error) {
    loading.querySelector(".bubble").textContent = error.name === "TimeoutError"
      ? "The request timed out. Please try again."
      : error.message;
    loading.querySelector(".bubble").style.color = "#a33";
  } finally {
    busy = false;
    input.focus();
  }
}

composer.addEventListener("submit", (event) => { event.preventDefault(); send(input.value); });
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); composer.requestSubmit(); }
});
input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 130)}px`; });
document.querySelectorAll(".suggestions button").forEach((button) => button.addEventListener("click", () => send(button.textContent)));
clearButton.addEventListener("click", () => { messages = []; thread.innerHTML = document.querySelector(".welcome") ? document.querySelector(".welcome").outerHTML : `<div class="welcome"><div class="welcome-mark">✳</div><h2>What should we look into?</h2><p>Ask Signal anything.</p></div>`; title.textContent = "New research"; input.focus(); });
