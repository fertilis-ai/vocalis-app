import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { audioUrl, type VadSegment } from "@/lib/engines/local";
import { cn } from "@/lib/utils";

// Static waveform of an audio file with click-to-seek playback and optional
// highlighted spans (the VAD tool's speech segments). The file is read via
// the asset protocol — decoding for display happens in the webview, which is
// a file workflow, not the realtime capture path (spec §3.2).

export interface WaveformHandle {
  /** Play [start, end) seconds; end omitted = play to the file's end. */
  playRange: (start: number, end?: number) => void;
  stop: () => void;
}

interface WaveformProps {
  path: string;
  segments?: VadSegment[];
  className?: string;
}

const BUCKETS = 600;

async function decodePeaks(
  path: string,
): Promise<{ peaks: number[]; duration: number }> {
  const response = await fetch(audioUrl(path));
  if (!response.ok) throw new Error(`could not read ${path}`);
  const encoded = await response.arrayBuffer();
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(encoded);
    const data = buffer.getChannelData(0);
    const bucketSize = Math.max(1, Math.floor(data.length / BUCKETS));
    const peaks: number[] = [];
    for (let i = 0; i < data.length; i += bucketSize) {
      let peak = 0;
      const end = Math.min(i + bucketSize, data.length);
      for (let j = i; j < end; j++) {
        peak = Math.max(peak, Math.abs(data[j]));
      }
      peaks.push(peak);
    }
    return { peaks, duration: buffer.duration };
  } finally {
    void context.close();
  }
}

export const Waveform = forwardRef<WaveformHandle, WaveformProps>(
  function Waveform({ path, segments, className }, ref) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const overlayColorRef = useRef<HTMLSpanElement | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const rangeEndRef = useRef<number | null>(null);
    const [peaks, setPeaks] = useState<number[] | null>(null);
    const [duration, setDuration] = useState(0);
    const [playhead, setPlayhead] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
      let stale = false;
      setPeaks(null);
      setError(null);
      setPlayhead(null);
      decodePeaks(path)
        .then((decoded) => {
          if (stale) return;
          setPeaks(decoded.peaks);
          setDuration(decoded.duration);
        })
        .catch((err) => !stale && setError(String(err)));
      return () => {
        stale = true;
      };
    }, [path]);

    // One audio element per file; playhead tracked with rAF because
    // timeupdate is too coarse to stop precisely at a segment boundary.
    useEffect(() => {
      const audio = new Audio(audioUrl(path));
      audioRef.current = audio;
      let frame = 0;
      const track = () => {
        if (!audio.paused) {
          const end = rangeEndRef.current;
          if (end !== null && audio.currentTime >= end) {
            audio.pause();
            setPlayhead(null);
          } else {
            setPlayhead(audio.currentTime);
          }
        }
        frame = requestAnimationFrame(track);
      };
      frame = requestAnimationFrame(track);
      const onEnded = () => setPlayhead(null);
      audio.addEventListener("ended", onEnded);
      return () => {
        cancelAnimationFrame(frame);
        audio.removeEventListener("ended", onEnded);
        audio.pause();
        audioRef.current = null;
      };
    }, [path]);

    const playRange = useCallback((start: number, end?: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      rangeEndRef.current = end ?? null;
      audio.currentTime = start;
      void audio.play();
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        playRange,
        stop: () => {
          audioRef.current?.pause();
          setPlayhead(null);
        },
      }),
      [playRange],
    );

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas || !peaks) return;
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);

      const barColor = getComputedStyle(canvas).color;
      const accentColor = overlayColorRef.current
        ? getComputedStyle(overlayColorRef.current).color
        : barColor;

      // Speech-span overlays behind the bars.
      if (segments && duration > 0) {
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = accentColor;
        for (const segment of segments) {
          const x = (segment.start / duration) * width;
          const w = ((segment.end - segment.start) / duration) * width;
          ctx.fillRect(x, 0, Math.max(w, 1), height);
        }
        ctx.globalAlpha = 1;
      }

      ctx.fillStyle = barColor;
      const mid = height / 2;
      const barWidth = width / peaks.length;
      for (let i = 0; i < peaks.length; i++) {
        const h = Math.max(1, peaks[i] * (height - 2));
        ctx.fillRect(i * barWidth, mid - h / 2, Math.max(barWidth * 0.7, 0.5), h);
      }

      if (playhead !== null && duration > 0) {
        ctx.fillStyle = accentColor;
        ctx.fillRect((playhead / duration) * width, 0, 1.5, height);
      }
    }, [peaks, segments, playhead, duration]);

    const seek = useCallback(
      (event: React.MouseEvent<HTMLCanvasElement>) => {
        if (!duration) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const fraction = (event.clientX - rect.left) / rect.width;
        playRange(fraction * duration);
      },
      [duration, playRange],
    );

    if (error) {
      return (
        <p className={cn("text-destructive text-xs", className)}>{error}</p>
      );
    }

    return (
      <div className={cn("relative", className)}>
        <span ref={overlayColorRef} className="hidden text-primary" />
        <canvas
          ref={canvasRef}
          onClick={seek}
          className="h-24 w-full cursor-crosshair text-muted-foreground"
          role="img"
          aria-label="Audio waveform — click to play from a position"
        />
        {!peaks && (
          <div className="absolute inset-0 animate-pulse rounded-md bg-muted/50" />
        )}
      </div>
    );
  },
);
