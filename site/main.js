// Suho landing — hero load sequence, cursor tilt, scroll reveals.
// Motion per the design skill; everything collapses to fades under
// prefers-reduced-motion (CSS) and tilt is skipped entirely (here).

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// load sequence trigger
addEventListener("DOMContentLoaded", () => {
  requestAnimationFrame(() => {
    document.body.classList.remove("pre");
    document.body.classList.add("loaded");
  });
});

// cursor tilt on the hero card (max ±9°, perspective on .hero-stage)
const stage = document.getElementById("stage");
const card = document.getElementById("card3d");
if (stage && card && !reducedMotion && matchMedia("(pointer: fine)").matches) {
  stage.addEventListener("mousemove", (e) => {
    const r = stage.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    card.style.transform = `rotateY(${(x * 18).toFixed(2)}deg) rotateX(${(-y * 18).toFixed(2)}deg)`;
  });
  stage.addEventListener("mouseleave", () => {
    card.style.transform = "";
  });
}

// live "names indexed" count — the registry grows, so read the real total from
// the guardian rather than shipping a number that drifts stale. A no-match query
// keeps it light (total is the full registry count regardless of the query); the
// static HTML is the fallback if the guardian is unreachable.
const GUARDIAN = "https://api.suhowallet.com";
const countEl = document.getElementById("names-indexed");
if (countEl) {
  fetch(`${GUARDIAN}/directory?q=zzzzzzzznomatch`)
    .then((r) => r.json())
    .then((d) => {
      if (typeof d.total === "number" && d.total > 0) {
        countEl.textContent = `${d.total.toLocaleString()} verified names indexed`;
      }
    })
    .catch(() => {});
}

// scroll reveals
const io = new IntersectionObserver(
  (entries) => {
    for (const en of entries) {
      if (en.isIntersecting) {
        en.target.classList.add("in");
        io.unobserve(en.target);
      }
    }
  },
  { threshold: 0.15 },
);
document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
