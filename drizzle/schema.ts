import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, bigint } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Conversion jobs table - tracks each video conversion request.
 */
export const conversionJobs = mysqlTable("conversion_jobs", {
  id: int("id").autoincrement().primaryKey(),
  jobId: varchar("jobId", { length: 64 }).notNull().unique(),
  userId: int("userId"),
  originalFilename: text("originalFilename").notNull(),
  originalSize: bigint("originalSize", { mode: "number" }),
  status: mysqlEnum("status", ["uploading", "converting", "uploading_result", "completed", "failed"]).default("uploading").notNull(),
  progress: int("progress").default(0).notNull(),
  errorMessage: text("errorMessage"),
  outputUrl: text("outputUrl"),
  outputFilename: text("outputFilename"),
  sourceWidth: int("sourceWidth"),
  sourceHeight: int("sourceHeight"),
  sourceFps: varchar("sourceFps", { length: 32 }),
  sourceDuration: varchar("sourceDuration", { length: 32 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ConversionJob = typeof conversionJobs.$inferSelect;
export type InsertConversionJob = typeof conversionJobs.$inferInsert;