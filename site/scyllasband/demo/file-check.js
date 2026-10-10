// Opened straight from disk, browsers block the module scripts, worker and storage this page needs, so say so
// instead of leaving the start button stuck. A classic script, because module scripts don't load from file:// at all.
if (location.protocol === 'file:') {
  document.addEventListener('DOMContentLoaded', () => {
    const start = document.getElementById('start');
    const warning = document.getElementById('warning');
    start.textContent = 'Needs a web server';
    warning.textContent = 'This page was opened from a file, and browsers don\'t let file pages run the demo. ' +
      'From the website folder, run "node demo-src/serve.mjs 8080" and open http://127.0.0.1:8080/scyllasband/demo/ instead.';
    warning.hidden = false;
  });
}
