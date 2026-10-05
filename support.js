(() => {
  const state = { messages: [], open: false, busy: false };

  function el(id) { return document.getElementById(id); }

  function appendMessage(role, content) {
    const wrap = el("supportMessages");
    if (!wrap) return;
    const row = document.createElement("div");
    row.className = `support-msg ${role}`;
    const label = role === "user" ? "You" : "ShortSpark AI";
    const lab = document.createElement("div");
    lab.className = "support-label";
    lab.textContent = label;
    const bubble = document.createElement("div");
    bubble.className = "support-bubble";
    bubble.textContent = content;
    row.append(lab, bubble);
    wrap.appendChild(row);
    wrap.scrollTop = wrap.scrollHeight;
  }

  function setOpen(value) {
    state.open = value;
    const root = el("supportWidget");
    if (root) root.classList.toggle("open", value);
    if (value) el("supportInput")?.focus();
  }

  async function sendMessage() {
    const input = el("supportInput");
    const sendBtn = el("supportSend");
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
    const lab = document.createElement("div");
    lab.className = "support-label";
    lab.textContent = "ShortSpark AI";
    const bubble = document.createElement("div");
    bubble.className = "support-bubble";
    bubble.textContent = "Thinking…";
    typing.append(lab, bubble);
    el("supportMessages")?.appendChild(typing);

    try {
      const response = await fetch("/api/support/chat", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: state.messages })
      });

      const data = await response.json().catch(() => ({}));
      document.getElementById("supportTyping")?.remove();

      if (!response.ok) {
        throw new Error(data.error || "Support is temporarily unavailable.");
      }

      const answer = String(data.answer || "I don't have an answer for that yet.");
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
    const root = el("supportWidget");
    if (!root) return;

    const toggle = el("supportToggle");
    const close = el("supportClose");
    const send = el("supportSend");
    const input = el("supportInput");

    toggle?.addEventListener("click", event => {
      // If the control is an <a>, prevent navigation only when the widget exists.
      event.preventDefault();
      setOpen(!state.open);
    });
    close?.addEventListener("click", () => setOpen(false));
    send?.addEventListener("click", sendMessage);
    input?.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    });

    if (!el("supportMessages")?.children.length) {
      appendMessage("assistant", "Hi! I'm ShortSpark AI Support. Ask about plans, billing, prompts, video generation, or troubleshooting.");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();