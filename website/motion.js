// Progressive enhancement: all content remains visible without JavaScript.
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const cards = [...document.querySelectorAll('[data-reveal]')];
const parallax = [...document.querySelectorAll('[data-drift]')];
let observer;
let frame = 0;

function updateScroll() {
  frame = 0;
  const height = window.innerHeight;
  for (const element of parallax) {
    const bounds = element.getBoundingClientRect();
    if (bounds.bottom < 0 || bounds.top > height) continue;
    const amount = Math.max(-1, Math.min(1, (bounds.top + bounds.height / 2 - height / 2) / height));
    element.style.setProperty('--drift', (amount * 16).toFixed(1) + 'px');
  }
}
function scheduleScroll() {
  if (!frame) frame = requestAnimationFrame(updateScroll);
}
function configureMotion() {
  observer?.disconnect();
  window.removeEventListener('scroll', scheduleScroll);
  window.removeEventListener('resize', scheduleScroll);
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  cards.forEach(element => element.classList.remove('ink-waiting'));
  parallax.forEach(element => element.style.removeProperty('--drift'));
  if (reducedMotion.matches || !('IntersectionObserver' in window)) return;
  observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.remove('ink-waiting');
      entry.target.classList.add('ink-visible');
      observer.unobserve(entry.target);
    }
  }, {threshold: 0.12});
  cards.forEach(element => {
    if (element.getBoundingClientRect().top > window.innerHeight) element.classList.add('ink-waiting');
    observer.observe(element);
  });
  window.addEventListener('scroll', scheduleScroll, {passive: true});
  window.addEventListener('resize', scheduleScroll, {passive: true});
  scheduleScroll();
}
reducedMotion.addEventListener('change', configureMotion);
configureMotion();
window.addEventListener('pagehide', () => {
  observer?.disconnect();
  if (frame) cancelAnimationFrame(frame);
  window.removeEventListener('scroll', scheduleScroll);
  window.removeEventListener('resize', scheduleScroll);
});
window.addEventListener('pageshow', event => { if (event.persisted) configureMotion(); });
