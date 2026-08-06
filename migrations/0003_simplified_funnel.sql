CREATE TABLE "simplified_scheduled_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"funnel_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"payment_id" uuid,
	"execute_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "simplified_scheduled_payment_kind_ref_unique" UNIQUE("payment_id","kind","ref_id")
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "simplified_ctx" jsonb;--> statement-breakpoint
ALTER TABLE "simplified_scheduled_tasks" ADD CONSTRAINT "simplified_scheduled_tasks_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simplified_scheduled_tasks" ADD CONSTRAINT "simplified_scheduled_tasks_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simplified_scheduled_tasks" ADD CONSTRAINT "simplified_scheduled_tasks_funnel_id_funnels_id_fk" FOREIGN KEY ("funnel_id") REFERENCES "public"."funnels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simplified_scheduled_tasks" ADD CONSTRAINT "simplified_scheduled_tasks_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;