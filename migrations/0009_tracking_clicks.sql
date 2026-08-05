CREATE TABLE "tracking_clicks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"bot_id" uuid NOT NULL,
	"platform" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_content" text,
	"utm_term" text,
	"fbclid" text,
	"gclid" text,
	"ttclid" text,
	"client_ip" text,
	"user_agent" text,
	"lead_id" uuid,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracking_clicks_token_key" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "tracking_clicks" ADD CONSTRAINT "tracking_clicks_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tracking_clicks" ADD CONSTRAINT "tracking_clicks_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "tracking_clicks_bot_id_created_at_idx" ON "tracking_clicks" ("bot_id", "created_at");
