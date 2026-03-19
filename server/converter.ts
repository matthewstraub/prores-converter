import { spawn, execFile } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

export interface ProbeResult {
  width: number;
  height: number;
  fps: string;
  duration: string;
  hasAudio: boolean;
}

/**
 * Probe a video file to get its metadata using ffprobe.
 */
export function probeVideo(inputPath: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
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
 * Convert a video to ProRes 422 QuickTime format with the following specs:
 * - Video Codec: Apple ProRes 422 (profile=standard, i.e. profile 2)
 * - Frame Rate: 29.97 fps
 * - Frame Size: 1920 x 1080 px
 * - Audio Codec: Uncompressed PCM signed 24-bit little-endian
 * - Sample Rate: 48000 Hz
 * - Container: QuickTime (.mov)
 */
export async function convertToProRes(options: ConvertOptions): Promise<void> {
  const { inputPath, outputPath, onProgress } = options;

  // Probe the source to get dimensions
  const probe = await probeVideo(inputPath);

  // Build the video filter
  const videoFilter = buildScalePadFilter(probe.width, probe.height);

  // Build FFmpeg arguments
  const args: string[] = [
    "-y",                          // Overwrite output
    "-i", inputPath,               // Input file
    "-vf", videoFilter,            // Scale + pad filter
    "-c:v", "prores_ks",          // ProRes encoder
    "-profile:v", "2",            // Profile 2 = ProRes 422 (standard)
    "-vendor", "apl0",            // Apple vendor tag for compatibility
    "-pix_fmt", "yuv422p10le",    // 10-bit 4:2:2
    "-r", "30000/1001",           // 29.97 fps (NTSC)
    "-s", "1920x1080",            // Ensure exact output size
  ];

  // Audio settings
  if (probe.hasAudio) {
    args.push(
      "-c:a", "pcm_s24le",       // Uncompressed 24-bit PCM
      "-ar", "48000",             // 48kHz sample rate
    );
  } else {
    // Generate silent audio track if source has no audio
    args.push(
      "-f", "lavfi",
      "-i", "anullsrc=r=48000:cl=stereo",
      "-shortest",
      "-c:a", "pcm_s24le",
      "-ar", "48000",
    );
  }

  args.push(
    "-f", "mov",                   // QuickTime container
    outputPath,
  );

  // Get duration for progress calculation
  const totalDuration = parseFloat(probe.duration) || 0;

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", args, {
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
