import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const devRegistrationsTable = pgTable("dev_registrations", {
  id:        serial("id").primaryKey(),
  wallet:    text("wallet").notNull().unique(),
  email:     text("email"),
  status:    text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeysTable = pgTable("api_keys", {
  id:        serial("id").primaryKey(),
  wallet:    text("wallet").notNull(),
  keyHash:   text("key_hash").notNull().unique(),
  keyPrefix: text("key_prefix").notNull(),
  status:    text("status").notNull().default("active"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertDevRegistrationSchema = createInsertSchema(devRegistrationsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertDevRegistration = z.infer<typeof insertDevRegistrationSchema>;
export type DevRegistration = typeof devRegistrationsTable.$inferSelect;

export const insertApiKeySchema = createInsertSchema(apiKeysTable).omit({ id: true, createdAt: true });
export type InsertApiKey = z.infer<typeof insertApiKeySchema>;
export type ApiKey = typeof apiKeysTable.$inferSelect;
