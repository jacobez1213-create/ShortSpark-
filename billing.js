(() => {
  const routeToCheckout = async (plan) => {
    const safePlan = plan === "creator" || plan === "pro" ? plan : null;
    if (!safePlan) return;

    const buttons = [...document.querySelectorAll(`[data-plan="${safePlan}"]`)];
    buttons.forEach(btn => { btn.disabled = true; btn.dataset.original = btn.textContent; btn.textContent = "Opening checkout…"; });

    try {
      const me = await fetch("/api/auth/me", { credentials: "include", cache: "no-store" });
      if (me.status === 401) {
        location.href = `/account?next=${encodeURIComponent(safePlan)}`;
        return;
      }

      const meData = await me.json().catch(() => ({}));
      if (!me.ok) throw new Error(meData.error || "Your account could not be verified.");

      const r = await fetch("/api/create-checkout-session", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: safePlan })
      });

      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.url) throw new Error(d.error || "Stripe Checkout could not be started.");

      location.assign(d.url);
    } catch (err) {
      buttons.forEach(btn => {
        btn.disabled = false;
        btn.textContent = btn.dataset.original || "Choose plan";
      });
      const msg = document.getElementById("billingError");
      if (msg) {
        msg.hidden = false;
        msg.textContent = err.message || "Checkout could not be opened.";
      } else {
        alert(err.message || "Checkout could not be opened.");
      }
    }
  };

  window.ShortSparkCheckout = routeToCheckout;

  document.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-plan]");
    if (!btn) return;
    event.preventDefault();
    routeToCheckout(btn.dataset.plan);
  });

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-plan]").forEach(btn => btn.removeAttribute("onclick"));
  });
})();