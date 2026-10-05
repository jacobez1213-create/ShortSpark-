(() => {
  const isPlan = plan => plan === "creator" || plan === "pro";

  function setError(message) {
    const box = document.getElementById("billingError");
    if (box) {
      box.hidden = false;
      box.textContent = message;
      box.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else {
      alert(message);
    }
  }

  async function checkout(plan, fallbackHref) {
    if (!isPlan(plan)) return;
    const controls = [...document.querySelectorAll(`[data-plan="${plan}"]`)];
    controls.forEach(c => {
      c.dataset.busy = "1";
      c.setAttribute("aria-busy", "true");
      c.dataset.original = c.textContent;
      c.textContent = "Opening checkout…";
      if ("disabled" in c) c.disabled = true;
    });

    try {
      const me = await fetch("/api/auth/me", { credentials: "include", cache: "no-store" });
      if (me.status === 401) {
        location.assign(`/account?next=${encodeURIComponent(plan)}`);
        return;
      }
      if (!me.ok) throw new Error("We couldn't verify your account. Please sign in again.");

      // Primary path: normal browser navigation to the first-party checkout route.
      // This also avoids client-side JSON/redirect edge cases and works with ad/privacy extensions.
      location.assign(fallbackHref || `/subscribe/${plan}`);
    } catch (err) {
      // Last-resort navigation still works even when fetch is blocked.
      location.assign(fallbackHref || `/subscribe/${plan}`);
    }
  }

  function init() {
    document.querySelectorAll('[data-plan]').forEach(control => {
      const plan = control.dataset.plan;
      if (!isPlan(plan) || control.dataset.checkoutBound === "1") return;
      control.dataset.checkoutBound = "1";

      // Convert accidental buttons to a working client-side action.
      control.addEventListener("click", event => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        event.stopPropagation();
        checkout(plan, control.getAttribute("href") || `/subscribe/${plan}`);
      });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();