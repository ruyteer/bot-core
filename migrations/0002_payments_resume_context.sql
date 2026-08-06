ALTER TABLE "payments" ADD COLUMN "funnel_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "progress_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "node_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "paid_handle" text;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_funnel_id_funnels_id_fk" FOREIGN KEY ("funnel_id") REFERENCES "public"."funnels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_progress_id_lead_progress_id_fk" FOREIGN KEY ("progress_id") REFERENCES "public"."lead_progress"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_node_id_funnel_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."funnel_nodes"("id") ON DELETE set null ON UPDATE no action;
