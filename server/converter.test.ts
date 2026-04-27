import { describe, expect, it, vi, beforeEach } from "vitest";
import { getTempDir, cleanupFile } from "./converter";
import path from "path";
import fs from "fs";
import os from "os";

describe("converter utilities", () => {
  describe("getTempDir", () => {
    it("returns a path under the system temp directory", () => {
      const dir = getTempDir();
      expect(dir).toContain("prores-converter");
      expect(dir.startsWith(os.tmpdir())).toBe(true);
    });

    it("creates the directory if it does not exist", () => {
      const dir = getTempDir();
      expect(fs.existsSync(dir)).toBe(true);
    });
  });

  describe("cleanupFile", () => {
    it("removes an existing file", () => {
      const dir = getTempDir();
      const testFile = path.join(dir, "test-cleanup.txt");
      fs.writeFileSync(testFile, "test");
      expect(fs.existsSync(testFile)).toBe(true);

      cleanupFile(testFile);
      expect(fs.existsSync(testFile)).toBe(false);
    });

    it("does not throw for non-existent file", () => {
      expect(() => cleanupFile("/tmp/nonexistent-file-12345.txt")).not.toThrow();
    });
  });
});

describe("converter FFmpeg command building", () => {
  it("should have ffmpeg available on the system", async () => {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    const { stdout } = await execFileAsync("ffmpeg", ["-version"]);
    expect(stdout).toContain("ffmpeg version");
  });

  it("should have prores_ks encoder available", async () => {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    const { stdout } = await execFileAsync("ffmpeg", ["-codecs"], { maxBuffer: 5 * 1024 * 1024 });
    expect(stdout).toContain("prores");
  });

  it("should have pcm_s24le codec available", async () => {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    const { stdout } = await execFileAsync("ffmpeg", ["-codecs"], { maxBuffer: 5 * 1024 * 1024 });
    expect(stdout).toContain("pcm_s24le");
  });
});

describe("probeVideo", () => {
  it("rejects for a non-existent file", async () => {
    const { probeVideo } = await import("./converter");
    await expect(probeVideo("/tmp/nonexistent-video.mp4")).rejects.toThrow();
  });

  it("rejects for a non-video file", async () => {
    const { probeVideo } = await import("./converter");
    const dir = getTempDir();
    const testFile = path.join(dir, "not-a-video.txt");
    fs.writeFileSync(testFile, "this is not a video");

    await expect(probeVideo(testFile)).rejects.toThrow();

    cleanupFile(testFile);
  });

  it("returns audioChannels field in probe result", async () => {
    const { probeVideo } = await import("./converter");
    // Generate a short test video with stereo audio using FFmpeg
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    const dir = getTempDir();
    const testFile = path.join(dir, "test-probe-audio.mp4");

    await execFileAsync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-c:v", "libx264", "-c:a", "aac", "-ac", "2",
      testFile,
    ]);

    const result = await probeVideo(testFile);
    expect(result.hasAudio).toBe(true);
    expect(result.audioChannels).toBe(2);
    expect(result.width).toBe(320);
    expect(result.height).toBe(240);

    cleanupFile(testFile);
  }, 30000);
});

describe("convertToProRes", () => {
  it("rejects for a non-existent input file", async () => {
    const { convertToProRes } = await import("./converter");
    const dir = getTempDir();
    const outputPath = path.join(dir, "test-output.mov");

    await expect(
      convertToProRes({
        inputPath: "/tmp/nonexistent-input.mp4",
        outputPath,
      })
    ).rejects.toThrow();
  });
});
