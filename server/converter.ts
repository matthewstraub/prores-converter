import { spawn, execFile } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

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
 * Convert a video to ProRes 422 QuickTime format with AJA DDR-compatible output:
 * - Video Codec: Apple ProRes 422 (profile=standard, i.e. profile 2)
 * - Vendor ID: apl0 (Apple-compatible, not FFmpeg's default FFMP)
 * - Frame Rate: 29.97 fps (NTSC drop-frame)
 * - Frame Size: 1920 x 1080 px
 * - Audio: Two discrete mono PCM 24-bit 48kHz tracks (L and R)
 * - Timecode: Embedded tmcd track starting at 00:00:00;00
 * - Container: QuickTime (.mov) with faststart flag
 *
 * These settings ensure compatibility with AJA DDR hardware, which is strict
 * about ProRes container layout (atom structure, timecode track, and discrete
 * mono audio channels).
 */
export async function convertToProRes(options: ConvertOptions): Promise<void> {
  const { inputPath, outputPath, onProgress } = options;

  // Probe the source to get dimensions and audio info
  const probe = await probeVideo(inputPath);

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

  // Video encoding settings
  args.push(
    "-vf", videoFilter,            // Scale + pad filter
    "-c:v", "prores_ks",          // ProRes encoder
    "-profile:v", "2",            // Profile 2 = ProRes 422 (standard)
    "-vendor", "apl0",            // Apple vendor tag for AJA compatibility
    "-pix_fmt", "yuv422p10le",    // 10-bit 4:2:2
    "-r", "30000/1001",           // 29.97 fps (NTSC)
    "-s", "1920x1080",            // Ensure exact output size
  );

  // Audio settings — AJA DDRs expect two discrete mono tracks, not one stereo track.
  // We map the first audio stream twice and use pan filters to split L/R into
  // separate mono channels.
  if (probe.hasAudio) {
    if (probe.audioChannels >= 2) {
      // Source has stereo (or more) — split into two mono tracks
      args.push(
        "-map", "0:v:0",                        // Map video from input
        "-map", "0:a:0",                        // Map audio for left channel
        "-map", "0:a:0",                        // Map audio again for right channel
        "-c:a", "pcm_s24le",                    // Uncompressed 24-bit PCM
        "-ar", "48000",                         // 48kHz sample rate
        "-filter:a:0", "pan=mono|c0=c0",        // First audio output = left channel
        "-filter:a:1", "pan=mono|c0=c1",        // Second audio output = right channel
      );
    } else {
      // Source is mono — duplicate it to two mono tracks
      args.push(
        "-map", "0:v:0",                        // Map video from input
        "-map", "0:a:0",                        // Map audio for track 1
        "-map", "0:a:0",                        // Map audio for track 2 (duplicate)
        "-c:a", "pcm_s24le",                    // Uncompressed 24-bit PCM
        "-ar", "48000",                         // 48kHz sample rate
      );
    }
  } else {
    // No audio in source — generate two silent mono tracks
    // Input 1 is the anullsrc we added above
    args.push(
      "-map", "0:v:0",                          // Map video from input 0
      "-map", "1:a:0",                          // Map synthetic audio for left
      "-map", "1:a:0",                          // Map synthetic audio for right
      "-c:a", "pcm_s24le",                      // Uncompressed 24-bit PCM
      "-ar", "48000",                           // 48kHz sample rate
      "-filter:a:0", "pan=mono|c0=c0",          // Left channel (silence)
      "-filter:a:1", "pan=mono|c0=c1",          // Right channel (silence)
    );
  }

  // Timecode track — AJA DDRs expect a tmcd track to be present
  args.push(
    "-timecode", "00:00:00;00",                  // Drop-frame timecode for 29.97fps
  );

  // Container settings
  args.push(
    "-movflags", "+faststart",                   // Relocate moov atom for compatibility
    "-f", "mov",                                 // QuickTime container
    outputPath,
  );

  // Get duration for progress calculation
  const totalDuration = parseFloat(probe.duration) || 0;

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(getFfmpegPath(), args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderrData = "";

    ffmpeg.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stderrData += text;

      // Parse progress from FFmpeg stderr output
      if (totalDuration > 0 && onProgress) {
        const timeMatch = text.match(/time=(\d+):(\d+):(\d+)\.(\d+)/);
        if (timeMatch) {
          const hours = parseInt(timeMatch[1]);
          const minutes = parseInt(timeMatch[2]);
          const seconds = parseInt(timeMatch[3]);
          const centiseconds = parseInt(timeMatch[4]);
          const currentTime = hours * 3600 + minutes * 60 + seconds + centiseconds / 100;
          const percent = Math.min(Math.round((currentTime / totalDuration) * 100), 99);
          onProgress(percent);
        }
      }
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        onProgress?.(100);
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
