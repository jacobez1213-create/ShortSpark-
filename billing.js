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
    if (plan !== "creator" && plan !== "pro") return;
    const href = fallbackHref || `/subscribe/${plan}`;
    const controls = [...document.querySelectorAll(`[data-plan="${plan}"]`)];
    controls.forEach(c => {
      c.dataset.original = c.textContent;
      c.textContent = "Opening checkout…";
      if ("disabled" in c) c.disabled = true;
      c.setAttribute("aria-busy", "true");
    });

    // Primary path is first-party navigation, not an API fetch.
    // The server owns authentication, plan lookup, exact pricing and Stripe redirect.
    window.location.assign(href);
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