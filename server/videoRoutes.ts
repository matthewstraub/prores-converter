import express, { Router, Request, Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { conversionJobs } from "../drizzle/schema";
import { convertToProRes, probeVideo, getTempDir, cleanupFile } from "./converter";

// Configure multer for large file uploads
const upload = multer({
  dest: getTempDir(),
  limits: {
    fileSize: 10 * 1024 * 1024 * 1024, // 10GB max
  },
});

// In-memory job status for real-time progress (DB is source of truth for persistent state)
const jobProgress: Map<string, { status: string; progress: number; error?: string; outputUrl?: string; outputFilename?: string; outputPath?: string }> = new Map();

export function createVideoRouter(): Router {
  const router = Router();

  /**
   * POST /api/video/upload
   * Upload a video file and start conversion to ProRes 422.
   */
  router.post("/upload", upload.single("video"), async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No video file provided" });
      return;
    }

    const jobId = uuidv4();
    const originalFilename = file.originalname || "video.mp4";

    // Initialize job in memory
    jobProgress.set(jobId, { status: "converting", progress: 0 });

    // Create job record in DB
    try {
      const db = await getDb();
      if (db) {
        await db.insert(conversionJobs).values({
          jobId,
          originalFilename,
          originalSize: file.size,
          status: "converting",
          progress: 0,
        });
      }
    } catch (e) {
      console.error("Failed to create job record:", e);
    }

    // Respond immediately with the job ID
    res.json({ jobId, filename: originalFilename });

    // Start conversion in background
    processConversion(jobId, file.path, originalFilename).catch((err) => {
      console.error(`Conversion failed for job ${jobId}:`, err);
    });
  });

  /**
   * GET /api/video/status/:jobId
   * Get the current status of a conversion job.
   */
  router.get("/status/:jobId", async (req: Request, res: Response) => {
    const { jobId } = req.params;

    // Check in-memory status first (most up-to-date)
    const memStatus = jobProgress.get(jobId);
    if (memStatus) {
      res.json({
        jobId,
        status: memStatus.status,
        progress: memStatus.progress,
        error: memStatus.error,
        outputUrl: memStatus.outputUrl,
        outputFilename: memStatus.outputFilename,
      });
      return;
    }

    // Fall back to DB
    try {
      const db = await getDb();
      if (db) {
        const [job] = await db.select().from(conversionJobs).where(eq(conversionJobs.jobId, jobId)).limit(1);
        if (job) {
          res.json({
            jobId: job.jobId,
            status: job.status,
            progress: job.progress,
            error: job.errorMessage,
            outputUrl: job.outputUrl,
            outputFilename: job.outputFilename,
          });
          return;
        }
      }
    } catch (e) {
      console.error("Failed to query job status:", e);
    }

    res.status(404).json({ error: "Job not found" });
  });

  /**
   * GET /api/video/download/:jobId
   * Stream the converted file directly from the server's temp storage.
   */
  router.get("/download/:jobId", async (req: Request, res: Response) => {
    const { jobId } = req.params;

    const memStatus = jobProgress.get(jobId);
    if (!memStatus || memStatus.status !== "completed" || !memStatus.outputPath) {
      res.status(404).json({ error: "File not found or conversion not complete" });
      return;
    }

    const filePath = memStatus.outputPath;
    const filename = memStatus.outputFilename || "output.mov";

    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "Converted file no longer available. Please convert again." });
      return;
    }

    const stat = fs.statSync(filePath);

    // Support range requests for large files
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": "video/quicktime",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
      });

      const stream = fs.createReadStream(filePath, { start, end });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": stat.size,
        "Content-Type": "video/quicktime",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
        "Accept-Ranges": "bytes",
      });

      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
    }
  });

  return router;
}

/**
 * Background conversion process.
 * After conversion, the file stays on disk and is served via the /download endpoint.
 * This avoids the S3 2GB upload limit for large ProRes files.
 */
async function processConversion(jobId: string, inputPath: string, originalFilename: string): Promise<void> {
  const tempDir = getTempDir();
  const baseName = path.basename(originalFilename, path.extname(originalFilename));
  const outputFilename = `${baseName}_ProRes422.mov`;
  const outputPath = path.join(tempDir, `${jobId}_output.mov`);

  try {
    // Probe the source video
    const probe = await probeVideo(inputPath);

    // Update DB with source info
    const db = await getDb();
    if (db) {
      await db.update(conversionJobs)
        .set({
          sourceWidth: probe.width,
          sourceHeight: probe.height,
          sourceFps: probe.fps,
          sourceDuration: probe.duration,
          status: "converting",
        })
        .where(eq(conversionJobs.jobId, jobId));
    }

    // Convert the video
    await convertToProRes({
      inputPath,
      outputPath,
      onProgress: (percent) => {
        const current = jobProgress.get(jobId);
        if (current) {
          current.progress = percent;
          current.status = "converting";
        }
        // Update DB periodically (every 10%)
        if (percent % 10 === 0) {
          updateJobInDb(jobId, { progress: percent, status: "converting" }).catch(() => {});
        }
      },
    });

    // Cleanup the input file immediately (no longer needed)
    cleanupFile(inputPath);

    // Instead of uploading to S3, serve the file directly from the server.
    // The download URL points to our own /api/video/download/:jobId endpoint.
    const downloadUrl = `/api/video/download/${jobId}`;

    // Mark as completed — keep outputPath so the download endpoint can find it
    jobProgress.set(jobId, {
      status: "completed",
      progress: 100,
      outputUrl: downloadUrl,
      outputFilename,
      outputPath,
    });
    await updateJobInDb(jobId, {
      status: "completed",
      progress: 100,
      outputUrl: downloadUrl,
      outputFilename,
    });

  } catch (error: any) {
    const errorMessage = error.message || "Unknown conversion error";
    console.error(`Conversion error for job ${jobId}:`, errorMessage);

    jobProgress.set(jobId, {
      status: "failed",
      progress: 0,
      error: errorMessage,
    });
    await updateJobInDb(jobId, {
      status: "failed",
      errorMessage,
    }).catch(() => {});

    // Cleanup on failure
    cleanupFile(inputPath);
    cleanupFile(outputPath);
  }
}

async function updateJobInDb(jobId: string, updates: Record<string, any>): Promise<void> {
  try {
    const db = await getDb();
    if (db) {
      await db.update(conversionJobs)
        .set(updates)
        .where(eq(conversionJobs.jobId, jobId));
    }
  } catch (e) {
    console.warn(`Failed to update job ${jobId} in DB:`, e);
  }
}
