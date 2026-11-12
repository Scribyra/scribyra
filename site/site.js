// Native disclosure remains usable without JavaScript; enhance anchor focus only.
for (const link of document.querySelectorAll('a[href^="#"]')) {
  link.addEventListener('click', () => {
    const id = link.getAttribute('href').slice(1);
    const target = id && document.getElementById(id);
    if (target) { target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true }); }
  });
}
