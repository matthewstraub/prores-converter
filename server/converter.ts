import { spawn, execFile } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { patchMovForAja, checkVideoToolboxAvailable } from "./movPatcher";

/**
 * Get the FFmpeg/FFprobe binary paths.
 * In Electron mode, these are set via environment variables pointing to bundled binaries.
 * Otherwise, falls back to system-installed ffmpeg/ffprobe.
 */
function getFfmpegPath(): string {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

function getFfprobePath(): string {
  return process.env.FFPROBE_PATH || "ffprobe";
}

/** Cache the VideoToolbox availability check so we only run it once. */
let _vtAvailable: boolean | null = null;

async function isVideoToolboxAvailable(): Promise<boolean> {
  if (_vtAvailable !== null) return _vtAvailable;
  _vtAvailable = await checkVideoToolboxAvailable(getFfmpegPath());
  console.log(`[converter] prores_videotoolbox available: ${_vtAvailable}`);
  return _vtAvailable;
}

export interface ProbeResult {
  width: number;
  height: number;
  fps: string;
  duration: string;
  hasAudio: boolean;
  audioChannels: number;
}

/**
 * Probe a video file to get its metadata using ffprobe.
 */
export function probeVideo(inputPath: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    execFile(
      getFfprobePath(),
      [
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        inputPath,
      ],
      { maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          return reject(new Error(`ffprobe failed: ${stderr || error.message}`));
        }
        try {
          const data = JSON.parse(stdout);
          const videoStream = data.streams?.find((s: any) => s.codec_type === "video");
          const audioStream = data.streams?.find((s: any) => s.codec_type === "audio");

          if (!videoStream) {
            return reject(new Error("No video stream found in file"));
          }

          const width = videoStream.width || 0;
          const height = videoStream.height || 0;
          const fps = videoStream.r_frame_rate || "30/1";
          const duration = data.format?.duration || "0";

          resolve({
            width,
            height,
            fps,
            duration,
            hasAudio: !!audioStream,
            audioChannels: audioStream?.channels || 0,
          });
        } catch (e) {
          reject(new Error(`Failed to parse ffprobe output: ${e}`));
        }
      }
    );
  });
}

/**
 * Build the FFmpeg filter for scaling + padding to 1920x1080 without cropping.
 * If the source is already 16:9 at 1920x1080, just passes through.
 * Otherwise, scales to fit within 1920x1080 and pads with black bars.
 */
function buildScalePadFilter(srcWidth: number, srcHeight: number): string {
  // Scale to fit within 1920x1080 maintaining aspect ratio, then pad to exactly 1920x1080
  return "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1";
}

export interface ConvertOptions {
  inputPath: string;
  outputPath: string;
  onProgress?: (percent: number) => void;
}

/**
 * Convert a video to ProRes 422 QuickTime format with AJA DDR-compatible output.
 *
 * Encoding pipeline:
 * 1. FFmpeg encode using prores_videotoolbox (Apple's native encoder) when available,
 *    falling back to prores_ks (software encoder) otherwise.
 * 2. Post-encode binary patching of the .mov container to set AJA-specific atom
 *    metadata (handler names, ftyp minor_version) that FFmpeg cannot write natively.
 *
 * Output specification:
 * - Video: Apple ProRes 422 Standard (profile 2), 1920x1080, 29.97fps
 * - Video vendor_id: appl (via prores_videotoolbox) or apl0 (via prores_ks)
 * - Video field_order: top-bottom (tt) to match AJA convention
 * - Audio: Two discrete mono PCM 24-bit 48kHz tracks (L and R)
 * - Timecode: Embedded tmcd track starting at 00:00:00;00 (drop-frame)
 * - Container: QuickTime (.mov)
 * - Handler names: AJA Video/Sound/Time Code Media Handler (via atom patch)
 * - Container minor_version: 537199360 (via atom patch)
 *
 * Stream order: audio, audio, video, tmcd (matching AJA DDR gold standard)
 */
export async function convertToProRes(options: ConvertOptions): Promise<void> {
  const { inputPath, outputPath, onProgress } = options;

  // Probe the source to get dimensions and audio info
  const probe = await probeVideo(inputPath);

  // Check if Apple's native VideoToolbox ProRes encoder is available
  const useVideoToolbox = await isVideoToolboxAvailable();

  // Build the video filter
  const videoFilter = buildScalePadFilter(probe.width, probe.height);

  // Build FFmpeg arguments
  const args: string[] = [
    "-y",                          // Overwrite output
    "-i", inputPath,               // Input file
  ];

  // If source has no audio, add a synthetic silent source
  if (!probe.hasAudio) {
    args.push(
      "-f", "lavfi",
      "-i", "anullsrc=r=48000:cl=stereo",
      "-shortest",
    );
  }

  // --- Audio mapping FIRST to match AJA stream order (audio, audio, video, tmcd) ---
  // AJA DDRs expect streams in this order: audio 0, audio 1, video, tmcd
  // We place audio maps before video to achieve this.

  if (probe.hasAudio) {
    if (probe.audioChannels >= 2) {
      // Source has stereo (or more) — split into two mono tracks
      args.push(
        "-map", "0:a:0",                        // Map audio for left channel
        "-map", "0:a:0",                        // Map audio again for right channel
      );
    } else {
      // Source is mono — duplicate it to two mono tracks
      args.push(
        "-map", "0:a:0",                        // Map audio for track 1
        "-map", "0:a:0",                        // Map audio for track 2 (duplicate)
      );
    }
  } else {
    // No audio in source — map synthetic audio
    args.push(
      "-map", "1:a:0",                          // Map synthetic audio for left
      "-map", "1:a:0",                          // Map synthetic audio for right
    );
  }

  // Map video AFTER audio
  args.push("-map", "0:v:0");

  // --- Audio encoding settings ---
  args.push(
    "-c:a", "pcm_s24le",                        // Uncompressed 24-bit PCM
    "-ar", "48000",                              // 48kHz sample rate
  );

  // Apply pan filters for stereo-to-mono split
  if (probe.hasAudio && probe.audioChannels >= 2) {
    args.push(
      "-filter:a:0", "pan=mono|c0=c0",          // First audio output = left channel
      "-filter:a:1", "pan=mono|c0=c1",          // Second audio output = right channel
    );
  } else if (!probe.hasAudio) {
    args.push(
      "-filter:a:0", "pan=mono|c0=c0",          // Left channel (silence)
      "-filter:a:1", "pan=mono|c0=c0",          // Right channel (silence)
    );
  }
  // For mono source, no pan filter needed — just duplicated

  // --- Video encoding settings ---
  if (useVideoToolbox) {
    // Apple's native VideoToolbox encoder — produces genuine Apple ProRes atoms
    // with vendor_id=appl and encoder="Apple ProRes 422"
    args.push(
      "-vf", videoFilter,                        // Scale + pad filter
      "-c:v", "prores_videotoolbox",             // Apple native ProRes encoder
      "-profile:v", "2",                         // Profile 2 = ProRes 422 Standard
      "-allow_sw", "1",                          // Allow software fallback on Intel Macs
      "-pix_fmt", "yuv422p10le",                 // 10-bit 4:2:2
      "-r", "30000/1001",                        // 29.97 fps (NTSC)
      "-s", "1920x1080",                         // Ensure exact output size
    );
  } else {
    // Software encoder fallback — produces FFmpeg-tagged ProRes
    args.push(
      "-vf", videoFilter,                        // Scale + pad filter
      "-c:v", "prores_ks",                       // Software ProRes encoder
      "-profile:v", "2",                         // Profile 2 = ProRes 422 Standard
      "-vendor", "apl0",                         // Apple vendor tag
      "-pix_fmt", "yuv422p10le",                 // 10-bit 4:2:2
      "-r", "30000/1001",                        // 29.97 fps (NTSC)
      "-s", "1920x1080",                         // Ensure exact output size
    );
  }

  // Field order — AJA DDRs expect top-bottom even for progressive content
  args.push("-field_order", "tt");

  // Timecode track — AJA DDRs expect a tmcd track to be present
  args.push("-timecode", "00:00:00;00");         // Drop-frame timecode for 29.97fps

  // Container settings
  args.push(
    "-movflags", "+faststart",                   // Relocate moov atom for compatibility
    "-f", "mov",                                 // QuickTime container
    outputPath,
  );

  // Get duration for progress calculation
  const totalDuration = parseFloat(probe.duration) || 0;

  // Step 1: Run FFmpeg encode
  await new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn(getFfmpegPath(), args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderrData = "";

    ffmpeg.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stderrData += text;

      // Parse progress from FFmpeg stderr output
      // Cap at 95% during encoding — the remaining 5% is for atom patching
      if (totalDuration > 0 && onProgress) {
        const timeMatch = text.match(/time=(\d+):(\d+):(\d+)\.(\d+)/);
        if (timeMatch) {
          const hours = parseInt(timeMatch[1]);
          const minutes = parseInt(timeMatch[2]);
          const seconds = parseInt(timeMatch[3]);
          const centiseconds = parseInt(timeMatch[4]);
          const currentTime = hours * 3600 + minutes * 60 + seconds + centiseconds / 100;
          const percent = Math.min(Math.round((currentTime / totalDuration) * 95), 95);
          onProgress(percent);
        }
      }
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        // Extract last few lines for error context
        const lines = stderrData.split("\n").filter(l => l.trim());
        const errorContext = lines.slice(-5).join("\n");
        reject(new Error(`FFmpeg exited with code ${code}: ${errorContext}`));
      }
    });

    ffmpeg.on("error", (err) => {
      reject(new Error(`Failed to start FFmpeg: ${err.message}`));
    });
  });

  // Step 2: Post-encode atom patching for AJA DDR compatibility
  // This patches handler names, ftyp minor_version, and other container-level
  // metadata that FFmpeg cannot set natively.
  onProgress?.(96);
  try {
    console.log("[converter] Patching MOV atoms for AJA DDR compatibility...");
    await patchMovForAja(outputPath);
    console.log("[converter] MOV atom patching complete.");
  } catch (patchError) {
    // Atom patching failure is non-fatal — the file is still valid ProRes,
    // just may not play on strict AJA DDR hardware
    console.warn("[converter] MOV atom patching failed (non-fatal):", patchError);
  }

  onProgress?.(100);
}

/**
 * Get a temporary directory for storing conversion files.
 */
export function getTempDir(): string {
  const dir = path.join(os.tmpdir(), "prores-converter");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Clean up a temporary file.
 */
export function cleanupFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (e) {
    console.warn(`Failed to cleanup file ${filePath}:`, e);
  }
}
