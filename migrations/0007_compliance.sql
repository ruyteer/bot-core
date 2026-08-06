CREATE TABLE IF NOT EXISTS "blocked_keywords" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "keyword"    text NOT NULL,
  "category"   text DEFAULT 'geral' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "blocked_keywords_keyword_key" UNIQUE ("keyword")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "compliance_alerts" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_type"        text NOT NULL,
  "source_id"          uuid NOT NULL,
  "user_id"            uuid,
  "keywords"           jsonb DEFAULT '[]'::jsonb NOT NULL,
  "category"           text,
  "snippet"            text,
  "status"             text DEFAULT 'pending' NOT NULL,
  "dismissed_keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at"         timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"         timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "compliance_alerts_source_type_source_id_key" UNIQUE ("source_type", "source_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "compliance_alerts" ADD CONSTRAINT "compliance_alerts_user_id_profiles_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "compliance_alerts_status_idx" ON "compliance_alerts" ("status");
