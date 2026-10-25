/* Pictures of the preview (FR-029). The framed page is another origin, so
   no DOM capture can see into it; the browser's screen-capture API can,
   when the user shares this tab. One share dialog serves every picture of
   a design-mode session: the stream is held open and a picture is one
   frame of it, cropped to a box of the viewport. Browser-only: nothing
   here is testable without a screen. */
import type { Rect } from "./designmode";

/** whether this page may take pictures: the screen-capture API, which
 *  needs a secure page (https, or localhost) */
export const canShoot = (): boolean =>
  typeof navigator !== "undefined" && window.isSecureContext && typeof navigator.mediaDevices?.getDisplayMedia === "function";

/** why a picture cannot be taken here */
export const NO_SHOTS = "no picture: pictures need Chrome on an https page or on localhost";

const WRONG_SURFACE = "share this tab, not a window or a screen, for the picture to line up";

/** the share dialog's options: this tab, offered first, and nothing else */
const SHARE: DisplayMediaStreamOptions & Record<string, unknown> = {
  video: { displaySurface: "browser" },
  audio: false,
  preferCurrentTab: true,
  selfBrowserSurface: "include",
  surfaceSwitching: "exclude",
  monitorTypeSurfaces: "exclude",
};

const frames = (n: number): Promise<void> =>
  new Promise((resolve) => {
    const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(n);
  });

/** how long to wait for the stream's next frame before taking the one
 *  it has: a tab that does not change sends no new frames */
const FRAME_WAIT = 250;

/** a frame of the stream painted after what the page just changed: the
 *  browser's own video-frame callback where it has one (its first frames
 *  can still be an older size, and a still tab sends none, so each wait is
 *  short), else a few animation frames */
async function painted(video: HTMLVideoElement): Promise<void> {
  await frames(2);
  if (typeof video.requestVideoFrameCallback !== "function") {
    await frames(1);
    return;
  }
  const next = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, FRAME_WAIT);
      video.requestVideoFrameCallback(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  await next();
  await next();
}

/**
 * The shared tab as a video, and pictures cut from it. `shot` asks to share
 * on its first call (the call must come from a click or a key, so it runs
 * before anything else is awaited); `stop` ends the share, as the
 * browser's own "stop sharing" does, which `onStop` reports.
 */
export class Shooter {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  onStop: (() => void) | null = null;

  get sharing(): boolean {
    return this.stream !== null;
  }

  private async start(): Promise<HTMLVideoElement> {
    if (this.video) return this.video;
    const stream = await navigator.mediaDevices.getDisplayMedia(SHARE);
    const track = stream.getVideoTracks()[0];
    const surface = (track?.getSettings() as { displaySurface?: string } | undefined)?.displaySurface;
    if (surface && surface !== "browser") {
      for (const t of stream.getTracks()) t.stop();
      throw new Error(WRONG_SURFACE);
    }
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    if (!video.videoWidth) await new Promise<void>((resolve) => video.addEventListener("loadedmetadata", () => resolve(), { once: true }));
    track?.addEventListener("ended", () => {
      this.stop();
      this.onStop?.();
    });
    this.stream = stream;
    this.video = video;
    return video;
  }

  /** a png of `rect`, a box of this page's viewport in CSS pixels, as the
   *  tab shows now; the box is cut to the viewport */
  async shot(rect: Rect): Promise<Blob> {
    const video = await this.start();
    // what was just hidden or drawn must have painted and reached the stream
    await painted(video);
    // the stream is the tab's content area, so its frame maps onto the
    // viewport whatever the pixel ratio
    const sx = video.videoWidth / window.innerWidth;
    const sy = video.videoHeight / window.innerHeight;
    const x = Math.max(0, rect.x);
    const y = Math.max(0, rect.y);
    const w = Math.min(window.innerWidth, rect.x + rect.width) - x;
    const h = Math.min(window.innerHeight, rect.y + rect.height) - y;
    if (w < 1 || h < 1) throw new Error("the box is off the screen");
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * sx));
    canvas.height = Math.max(1, Math.round(h * sy));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("the picture could not be drawn");
    ctx.drawImage(video, x * sx, y * sy, w * sx, h * sy, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("the picture could not be encoded"))), "image/png"));
  }

  stop(): void {
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    if (this.video) this.video.srcObject = null;
    this.stream = null;
    this.video = null;
  }
}

/** the share was refused or dismissed, in a word the status line can show */
export const shotError = (err: unknown): string => {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError") return "no picture: the share was not allowed";
  return `no picture: ${String(err instanceof Error ? err.message : err)}`;
};
