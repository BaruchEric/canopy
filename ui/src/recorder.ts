import { useCallback, useEffect, useRef, useState } from "react";

/** why this page cannot record, or null when it can: the microphone needs a
 *  secure page and a browser with MediaRecorder */
export const recorderBlocked = (): string | null => {
  if (!window.isSecureContext) return "The microphone needs https or localhost";
  if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) return "This browser cannot record the microphone";
  return null;
};

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface Recorder {
  recording: boolean;
  /** the permission prompt is up or the stream is opening */
  pending: boolean;
  err: string | null;
  start: () => Promise<void>;
  /** ends the recording; the clip goes to `onClip` */
  stop: () => void;
  /** ends the recording without handing its clip to `onClip`; a pending
   *  permission request is stopped as soon as it answers */
  cancel: () => void;
}

/** One microphone recording at a time, handed to `onClip` as a file once it
 *  stops. `onRecording` says when a recording starts and ends. The
 *  microphone is let go on stop, on a recorder error, and on unmount. */
export function useRecorder(onClip: (file: File) => void, onRecording?: (on: boolean) => void): Recorder {
  const rec = useRef<MediaRecorder | null>(null);
  // false once the owner is gone: a permission prompt answered after that
  // must not leave the microphone on with nothing to stop it
  const alive = useRef(true);
  // one start at a time: a second click while the permission prompt is up
  // would make a second stream the first recorder's stop never reaches
  const starting = useRef(false);
  // Every start owns a generation. Cancel invalidates it, so a permission
  // prompt that resolves later can release its stream without recording.
  const generation = useRef(0);
  // the latest callbacks, so a recording started under old ones ends in the new
  const clip = useRef(onClip);
  const told = useRef(onRecording);
  clip.current = onClip;
  told.current = onRecording;
  const [pending, setPending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
      starting.current = false;
      const r = rec.current;
      if (!r) return;
      r.onstop = null;
      if (r.state !== "inactive") r.stop();
      for (const t of r.stream.getTracks()) t.stop();
    };
  }, []);

  const start = useCallback(async () => {
    if (starting.current || rec.current) return;
    const attempt = ++generation.current;
    starting.current = true;
    setPending(true);
    setErr(null);
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!alive.current || attempt !== generation.current) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      const live = stream;
      // Safari records mp4 only
      const type = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
      const r = new MediaRecorder(live, { mimeType: type });
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      r.onstop = () => {
        for (const t of live.getTracks()) t.stop();
        if (attempt !== generation.current) return;
        rec.current = null;
        setRecording(false);
        told.current?.(false);
        if (chunks.length === 0) return;
        const ext = type === "audio/webm" ? "webm" : "m4a";
        clip.current(new File(chunks, `voice-${Date.now()}.${ext}`, { type: r.mimeType || type }));
      };
      r.onerror = () => {
        // the recorder died: let go of the microphone and say so
        for (const t of live.getTracks()) t.stop();
        r.onstop = null;
        if (attempt !== generation.current) return;
        rec.current = null;
        setRecording(false);
        told.current?.(false);
        if (alive.current) setErr("the recording failed");
      };
      r.start();
      rec.current = r;
      setRecording(true);
      told.current?.(true);
    } catch (e) {
      // a recorder that failed to make or start leaves the microphone on
      if (stream) for (const t of stream.getTracks()) t.stop();
      if (attempt === generation.current) {
        rec.current = null;
        if (alive.current) setErr(errText(e));
      }
    } finally {
      if (attempt === generation.current) {
        starting.current = false;
        if (alive.current) setPending(false);
      }
    }
  }, []);

  const stop = useCallback(() => {
    const r = rec.current;
    if (r && r.state !== "inactive") r.stop();
  }, []);

  const cancel = useCallback(() => {
    generation.current++;
    // Let a new target start even if the browser has not resolved the old
    // permission prompt yet. That stale prompt releases its stream on arrival.
    starting.current = false;
    const r = rec.current;
    rec.current = null;
    if (r) {
      r.onstop = null;
      r.onerror = null;
      if (r.state !== "inactive") r.stop();
      for (const track of r.stream.getTracks()) track.stop();
    }
    setPending(false);
    setRecording(false);
    setErr(null);
    told.current?.(false);
  }, []);

  return { recording, pending, err, start, stop, cancel };
}
