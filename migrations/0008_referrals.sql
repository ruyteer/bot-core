CREATE TABLE "referral_codes" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"commission_percent" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_codes_code_key" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"referred_user_id" uuid PRIMARY KEY NOT NULL,
	"referrer_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referral_commissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referrer_user_id" uuid NOT NULL,
	"referred_user_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"base_fee_cents" integer NOT NULL,
	"percent" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_commissions_payment_id_key" UNIQUE("payment_id")
);
--> statement-breakpoint
CREATE TABLE "referral_withdrawals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"pix_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"notes" text,
	"processed_by" uuid,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referred_user_id_profiles_id_fk" FOREIGN KEY ("referred_user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_user_id_profiles_id_fk" FOREIGN KEY ("referrer_user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "referral_commissions" ADD CONSTRAINT "referral_commissions_referrer_user_id_profiles_id_fk" FOREIGN KEY ("referrer_user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "referral_commissions" ADD CONSTRAINT "referral_commissions_referred_user_id_profiles_id_fk" FOREIGN KEY ("referred_user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "referral_commissions" ADD CONSTRAINT "referral_commissions_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "referral_withdrawals" ADD CONSTRAINT "referral_withdrawals_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "referral_withdrawals" ADD CONSTRAINT "referral_withdrawals_processed_by_profiles_id_fk" FOREIGN KEY ("processed_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "referrals_referrer_user_id_idx" ON "referrals" ("referrer_user_id");
--> statement-breakpoint
CREATE INDEX "referral_commissions_referrer_user_id_idx" ON "referral_commissions" ("referrer_user_id");
--> statement-breakpoint
CREATE INDEX "referral_withdrawals_status_idx" ON "referral_withdrawals" ("status");
