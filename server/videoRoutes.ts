import express, { Router, Request, Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { conversionJobs } from "../drizzle/schema";
import { convertToProRes, probeVideo, getTempDir, cleanupFile } from "./converter";
import { storagePut } from "./storage";

// Configure multer for large file uploads
const upload = multer({
  dest: getTempDir(),
  limits: {
    fileSize: 10 * 1024 * 1024 * 1024, // 10GB max
  },
});

// In-memory job status for real-time progress (DB is source of truth for persistent state)
const jobProgress: Map<string, { status: string; progress: number; error?: string; outputUrl?: string; outputFilename?: string }> = new Map();

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

  return router;
}

/**
 * Background conversion process.
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

    // Upload to S3
    jobProgress.set(jobId, { status: "uploading_result", progress: 100 });
    await updateJobInDb(jobId, { status: "uploading_result", progress: 100 });

    const fileBuffer = fs.readFileSync(outputPath);
    const s3Key = `conversions/${jobId}/${outputFilename}`;
    const { url } = await storagePut(s3Key, fileBuffer, "video/quicktime");

    // Mark as completed
    jobProgress.set(jobId, {
      status: "completed",
      progress: 100,
      outputUrl: url,
      outputFilename,
    });
    await updateJobInDb(jobId, {
      status: "completed",
      progress: 100,
      outputUrl: url,
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
  } finally {
    // Cleanup temp files
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
