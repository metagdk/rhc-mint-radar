/* RHC Mint Radar — isolated mint-location links.
 * Reads the already-rendered Mint action from each collection row.
 * No new API calls and no secrets. Safe to remove independently.
 */
(() => {
  "use strict";
  if (window.__RHC_MINT_LINKS__) return;
  window.__RHC_MINT_LINKS__ = true;

  const ROOT = "#collections";
  const LINK_CLASS = "mint-location-link";

  function addLinks(root) {
    root.querySelectorAll(".rank-row[data-addr]").forEach((row) => {
      if (row.querySelector(`.${LINK_CLASS}`)) return;

      const primary = row.querySelector('.cell-act a.btn.primary[href]');
      const copy = row.querySelector('.col-copy');
      if (!primary || !copy) return;

      const href = primary.getAttribute("href");
      if (!href || href === "#") return;

      const link = document.createElement("a");
      link.className = LINK_CLASS;
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = "Open minting location";
      link.setAttribute("aria-label", "Open minting location");
      link.innerHTML = '<span aria-hidden="true">↗</span><span>Mint</span>';

      const meta = copy.querySelector(".col-meta");
      if (meta) meta.appendChild(link);
      else copy.appendChild(link);
    });
  }

  function boot() {
    const root = document.querySelector(ROOT);
    if (!root) return;

    addLinks(root);
    const observer = new MutationObserver(() => addLinks(root));
    observer.observe(root, { childList: true, subtree: true });

    // Prevent an observer from living forever if the page replaces the root.
    const rootGuard = new MutationObserver(() => {
      if (!document.contains(root)) {
        observer.disconnect();
        rootGuard.disconnect();
      }
    });
    rootGuard.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
