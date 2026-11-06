// Picks the cut for this screen: the vertical one on portrait screens, the widescreen one otherwise (the <source media>
// attributes do the same without JavaScript). Sets the matching poster, follows a rotation until playback starts, and
// adds a switch that keeps the playback position. Safari gets the HLS copy, other browsers the MP4.
const video = document.querySelector("video.launch");
const CUTS = {
  wide: { poster: "media/poster-16x9.jpg", hls: "media/r2/16x9/index.m3u8", mp4: "media/r2/launch-16x9.mp4" },
  tall: { poster: "media/poster-9x16.jpg", hls: "media/r2/9x16/index.m3u8", mp4: "media/r2/launch-9x16.mp4" },
};
const portrait = window.matchMedia("(orientation: portrait)");
const hls = video.canPlayType("application/vnd.apple.mpegurl") !== "";
const buttons = document.querySelectorAll(".cut-switch button");
let started = false;

function show(name) {
  if (video.dataset.cut === name) return;
  const cut = CUTS[name];
  const at = video.currentTime;
  const playing = !video.paused;
  video.querySelectorAll("source").forEach((source) => source.remove());
  video.dataset.cut = name;
  video.poster = cut.poster;
  video.src = hls ? cut.hls : cut.mp4;
  if (at > 0 || playing) {
    video.addEventListener("loadedmetadata", () => {
      video.currentTime = at;
      if (playing) video.play();
    }, { once: true });
  }
  buttons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.cut === name)));
}

show(portrait.matches ? "tall" : "wide");
video.addEventListener("play", () => { started = true; });
portrait.addEventListener("change", (event) => { if (!started) show(event.matches ? "tall" : "wide"); });
buttons.forEach((button) => button.addEventListener("click", () => show(button.dataset.cut)));
document.querySelector(".cut-switch").hidden = false;
