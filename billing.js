(() => {
  function setError(message) {
    const box = document.getElementById("billingError");
    if (box) {
      box.hidden = false;
      box.textContent = message;
    } else {
      alert(message);
    }
  }

  async function enhanceCheckout(link) {
    const href = link.getAttribute("href");
    if (!href || link.dataset.busy === "1") return;

    // The plain /subscribe/:plan link remains the fallback. JS only adds
    // a friendlier loading state and an early auth check.
    const plan = link.dataset.plan;
    if (plan !== "creator" && plan !== "pro") return;

    link.dataset.busy = "1";
    link.setAttribute("aria-busy", "true");
    const original = link.textContent;
    link.textContent = "Opening checkout…";

    try {
      const me = await fetch("/api/auth/me", {
        credentials: "include",
        cache: "no-store"
      });

      if (me.status === 401) {
        window.location.assign(`/account?next=${encodeURIComponent(plan)}`);
        return;
      }

      if (!me.ok) {
        // Let the normal GET route be the final authority.
        window.location.assign(href);
        return;
      }

      // Use the same first-party GET route. This avoids fragile client-side
      // JSON orchestration and works with browser navigation semantics.
      window.location.assign(href);
    } catch (err) {
      // Absolute fallback: plain browser navigation to /subscribe/:plan.
      window.location.assign(href);
    } finally {
      link.dataset.busy = "0";
      link.removeAttribute("aria-busy");
      link.textContent = original;
    }
  }

  function init() {
    document.querySelectorAll('a[data-plan][href^="/subscribe/"]').forEach(link => {
      link.addEventListener("click", event => {
        // Keep middle-click / Ctrl-click / Shift-click native.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        enhanceCheckout(link);
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();