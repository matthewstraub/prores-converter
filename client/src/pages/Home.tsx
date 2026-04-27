import { useState, useCallback, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Upload,
  FileVideo,
  Download,
  CheckCircle2,
  AlertCircle,
  Loader2,
  X,
  Film,
  Monitor,
  Volume2,
  Clock,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import axios from "axios";

type JobStatus = "idle" | "uploading" | "converting" | "uploading_result" | "completed" | "failed";

interface JobState {
  jobId: string | null;
  status: JobStatus;
  progress: number;
  uploadProgress: number;
  error: string | null;
  outputUrl: string | null;
  outputFilename: string | null;
  filename: string | null;
  fileSize: number | null;
}

const OUTPUT_SPECS = [
  { icon: Film, label: "Codec", value: "Apple ProRes 422" },
  { icon: Monitor, label: "Resolution", value: "1920 x 1080" },
  { icon: Clock, label: "Frame Rate", value: "29.97 fps" },
  { icon: Volume2, label: "Audio", value: "2× Mono PCM 24-bit" },
];

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function getStatusMessage(status: JobStatus, progress: number): string {
  switch (status) {
    case "uploading":
      return "Uploading video...";
    case "converting":
      return progress > 0 ? `Converting to ProRes 422... ${progress}%` : "Starting conversion...";
    case "uploading_result":
      return "Preparing download...";
    case "completed":
      return "Conversion complete!";
    case "failed":
      return "Conversion failed";
    default:
      return "";
  }
}

export default function Home() {
  const [job, setJob] = useState<JobState>({
    jobId: null,
    status: "idle",
    progress: 0,
    uploadProgress: 0,
    error: null,
    outputUrl: null,
    outputFilename: null,
    filename: null,
    fileSize: null,
  });
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  const startPolling = useCallback((jobId: string) => {
    if (pollingRef.current) clearInterval(pollingRef.current);

    pollingRef.current = setInterval(async () => {
      try {
        const res = await axios.get(`/api/video/status/${jobId}`);
        const data = res.data;

        setJob((prev) => ({
          ...prev,
          status: data.status as JobStatus,
          progress: data.progress || 0,
          error: data.error || null,
          outputUrl: data.outputUrl || null,
          outputFilename: data.outputFilename || null,
        }));

        if (data.status === "completed" || data.status === "failed") {
          if (pollingRef.current) clearInterval(pollingRef.current);
          pollingRef.current = null;
        }
      } catch (e) {
        console.error("Polling error:", e);
      }
    }, 1500);
  }, []);

  const handleUpload = useCallback(
    async (file: File) => {
      // Validate it's a video
      if (!file.type.startsWith("video/") && !file.name.match(/\.(mov|mp4|avi|mkv|wmv|flv|webm|m4v|mpg|mpeg|mts|m2ts|3gp|ts)$/i)) {
        setJob((prev) => ({
          ...prev,
          status: "failed",
          error: "Please select a valid video file.",
        }));
        return;
      }

      setJob({
        jobId: null,
        status: "uploading",
        progress: 0,
        uploadProgress: 0,
        error: null,
        outputUrl: null,
        outputFilename: null,
        filename: file.name,
        fileSize: file.size,
      });

      const formData = new FormData();
      formData.append("video", file);

      try {
        const res = await axios.post("/api/video/upload", formData, {
          headers: { "Content-Type": "multipart/form-data" },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          onUploadProgress: (progressEvent) => {
            if (progressEvent.total) {
              const percent = Math.round((progressEvent.loaded / progressEvent.total) * 100);
              setJob((prev) => ({ ...prev, uploadProgress: percent }));
            }
          },
        });

        const { jobId } = res.data;
        setJob((prev) => ({
          ...prev,
          jobId,
          status: "converting",
          progress: 0,
        }));

        startPolling(jobId);
      } catch (e: any) {
        const errorMsg = e.response?.data?.error || e.message || "Upload failed";
        setJob((prev) => ({
          ...prev,
          status: "failed",
          error: errorMsg,
        }));
      }
    },
    [startPolling]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) handleUpload(file);
    },
    [handleUpload]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleUpload(file);
      // Reset input so the same file can be re-selected
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [handleUpload]
  );

  const handleReset = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    setJob({
      jobId: null,
      status: "idle",
      progress: 0,
      uploadProgress: 0,
      error: null,
      outputUrl: null,
      outputFilename: null,
      filename: null,
      fileSize: null,
    });
  }, []);

  const isProcessing = job.status === "uploading" || job.status === "converting" || job.status === "uploading_result";
  const overallProgress =
    job.status === "uploading"
      ? job.uploadProgress * 0.15
      : job.status === "converting"
      ? 15 + job.progress * 0.75
      : job.status === "uploading_result"
      ? 95
      : job.status === "completed"
      ? 100
      : 0;

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Header — extra left padding clears macOS traffic-light buttons when
         running inside the Electron shell (titleBarStyle: hiddenInset). The
         -webkit-app-region: drag makes the header act as a window drag handle. */}
      <header className="border-b border-border/50 backdrop-blur-sm bg-background/80 sticky top-0 z-10" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <div className="max-w-5xl mx-auto pl-20 pr-4 sm:pr-6 py-4 flex items-center gap-3" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <div className="w-9 h-9 rounded-lg bg-primary/15 flex items-center justify-center">
            <Film className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">ProRes Converter</h1>
            <p className="text-xs text-muted-foreground">Convert any video to Apple ProRes 422 QuickTime</p>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center justify-center px-4 py-12">
        <div className="w-full max-w-2xl space-y-8">
          {/* Output Specs Bar */}
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="grid grid-cols-2 sm:grid-cols-4 gap-3"
          >
            {OUTPUT_SPECS.map((spec) => (
              <div
                key={spec.label}
                className="flex items-center gap-2.5 rounded-lg bg-card/60 border border-border/50 px-3 py-2.5"
              >
                <spec.icon className="w-4 h-4 text-primary shrink-0" />
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">{spec.label}</p>
                  <p className="text-xs font-medium text-foreground truncate">{spec.value}</p>
                </div>
              </div>
            ))}
          </motion.div>

          {/* Drop Zone / Status Area */}
          <AnimatePresence mode="wait">
            {job.status === "idle" ? (
              <motion.div
                key="dropzone"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ duration: 0.3 }}
              >
                <div
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onClick={() => fileInputRef.current?.click()}
                  className={`
                    relative group cursor-pointer rounded-2xl border-2 border-dashed
                    transition-all duration-300 ease-out
                    flex flex-col items-center justify-center
                    min-h-[320px] sm:min-h-[360px]
                    ${
                      isDragOver
                        ? "border-primary bg-primary/5 scale-[1.01]"
                        : "border-border/60 hover:border-primary/50 hover:bg-card/40"
                    }
                  `}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="video/*,.mov,.mp4,.avi,.mkv,.wmv,.flv,.webm,.m4v,.mpg,.mpeg,.mts,.m2ts,.3gp,.ts"
                    onChange={handleFileSelect}
                    className="hidden"
                  />

                  <motion.div
                    animate={isDragOver ? { scale: 1.1, y: -4 } : { scale: 1, y: 0 }}
                    transition={{ type: "spring", stiffness: 300, damping: 20 }}
                    className="mb-6"
                  >
                    <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center group-hover:bg-primary/15 transition-colors">
                      <Upload className="w-7 h-7 text-primary" />
                    </div>
                  </motion.div>

                  <p className="text-base font-medium text-foreground mb-1.5">
                    {isDragOver ? "Drop your video here" : "Drag & drop a video file"}
                  </p>
                  <p className="text-sm text-muted-foreground mb-5">
                    or click to browse your files
                  </p>
                  <p className="text-xs text-muted-foreground/70">
                    Supports MP4, MOV, AVI, MKV, MTS, and more
                  </p>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="status"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ duration: 0.3 }}
                className="rounded-2xl border border-border/60 bg-card/60 backdrop-blur-sm overflow-hidden"
              >
                {/* File Info */}
                <div className="px-6 pt-6 pb-4 flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                    <FileVideo className="w-6 h-6 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground truncate">{job.filename}</p>
                    {job.fileSize && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {formatFileSize(job.fileSize)}
                      </p>
                    )}
                  </div>
                  {(job.status === "completed" || job.status === "failed") && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={handleReset}
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  )}
                </div>

                {/* Progress Section */}
                <div className="px-6 pb-6">
                  {/* Status Message */}
                  <div className="flex items-center gap-2 mb-3">
                    {isProcessing && (
                      <Loader2 className="w-4 h-4 text-primary animate-spin shrink-0" />
                    )}
                    {job.status === "completed" && (
                      <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                    )}
                    {job.status === "failed" && (
                      <AlertCircle className="w-4 h-4 text-destructive shrink-0" />
                    )}
                    <p className="text-sm text-muted-foreground">
                      {getStatusMessage(job.status, job.progress)}
                    </p>
                  </div>

                  {/* Progress Bar */}
                  {isProcessing && (
                    <div className="space-y-2">
                      <Progress value={overallProgress} className="h-2" />
                      <p className="text-xs text-muted-foreground/70 text-right font-mono">
                        {Math.round(overallProgress)}%
                      </p>
                    </div>
                  )}

                  {/* Error Message */}
                  {job.status === "failed" && job.error && (
                    <div className="mt-3 p-3 rounded-lg bg-destructive/10 border border-destructive/20">
                      <p className="text-xs text-destructive/90 font-mono leading-relaxed break-all">
                        {job.error}
                      </p>
                    </div>
                  )}

                  {/* Completed Actions */}
                  {job.status === "completed" && job.outputUrl && (
                    <div className="mt-4 space-y-3">
                      <div className="p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/15">
                        <p className="text-xs text-emerald-400/90 font-mono">
                          {job.outputFilename}
                        </p>
                      </div>
                      <div className="flex gap-3">
                        <Button asChild className="flex-1 gap-2">
                          <a href={job.outputUrl} download={job.outputFilename}>
                            <Download className="w-4 h-4" />
                            Download ProRes File
                          </a>
                        </Button>
                        <Button variant="outline" onClick={handleReset} className="gap-2 bg-card">
                          <Upload className="w-4 h-4" />
                          New
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* Failed Actions */}
                  {job.status === "failed" && (
                    <div className="mt-4">
                      <Button variant="outline" onClick={handleReset} className="gap-2 bg-card">
                        <Upload className="w-4 h-4" />
                        Try Again
                      </Button>
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Footer Info */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5, duration: 0.4 }}
            className="text-center"
          >
            <p className="text-xs text-muted-foreground/60 leading-relaxed max-w-md mx-auto">
              Output: QuickTime (.mov) container with Apple ProRes 422 video at 1920x1080 29.97fps,
              two discrete mono PCM 24-bit 48kHz audio tracks, and embedded timecode. AJA DDR compatible.
              Non-16:9 sources are letterboxed/pillarboxed.
            </p>
          </motion.div>
        </div>
      </main>
    </div>
  );
}
