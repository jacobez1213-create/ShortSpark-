(() => {
  const state = { messages: [], open: false, busy: false };

  function appendMessage(role, content) {
    const wrap = document.getElementById("supportMessages");
    if (!wrap) return;
    const el = document.createElement("div");
    el.className = `support-msg ${role}`;
    const label = role === "user" ? "You" : "ShortSpark AI";
    el.innerHTML = `<div class="support-label">${label}</div><div class="support-bubble"></div>`;
    el.querySelector(".support-bubble").textContent = content;
    wrap.appendChild(el);
    wrap.scrollTop = wrap.scrollHeight;
  }

  async function send() {
    const input = document.getElementById("supportInput");
    const sendBtn = document.getElementById("supportSend");
    if (!input || !sendBtn || state.busy) return;
    const text = input.value.trim();
    if (!text) return;

    state.busy = true;
    sendBtn.disabled = true;
    input.value = "";
    state.messages.push({ role: "user", content: text });
    appendMessage("user", text);

    const typing = document.createElement("div");
    typing.className = "support-msg assistant";
    typing.id = "supportTyping";
    typing.innerHTML = '<div class="support-label">ShortSpark AI</div><div class="support-bubble">Thinking…</div>';
    document.getElementById("supportMessages").appendChild(typing);

    try {
      const r = await fetch("/api/support/chat", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: state.messages })
      });
      const d = await r.json().catch(() => ({}));
      document.getElementById("supportTyping")?.remove();
      if (!r.ok) throw new Error(d.error || "Support is temporarily unavailable.");
      const answer = String(d.answer || "I don't have an answer for that yet.");
      state.messages.push({ role: "assistant", content: answer });
      appendMessage("assistant", answer);
    } catch (err) {
      document.getElementById("supportTyping")?.remove();
      appendMessage("assistant", err.message || "Support is temporarily unavailable. Please try again.");
    } finally {
      state.busy = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  function init() {
    const root = document.getElementById("supportWidget");
    if (!root) return;

    const toggle = document.getElementById("supportToggle");
    const close = document.getElementById("supportClose");
    const send = document.getElementById("supportSend");
    const input = document.getElementById("supportInput");

    toggle?.addEventListener("click", () => {
      state.open = !state.open;
      root.classList.toggle("open", state.open);
      if (state.open) input?.focus();
    });
    close?.addEventListener("click", () => {
      state.open = false;
      root.classList.remove("open");
    });
    send?.addEventListener("click", send);
    input?.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });

    appendMessage("assistant", "Hi! I'm ShortSpark AI Support. Ask me about plans, billing, prompts, video generation, or troubleshooting.");
  }

  document.addEventListener("DOMContentLoaded", init);
})();