CREATE TABLE "indexer_checkpoints" (
	"chain_id" integer NOT NULL,
	"token_address" text NOT NULL,
	"last_block" bigint NOT NULL,
	"last_block_hash" text NOT NULL,
	"head_block" bigint NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "indexer_checkpoints_pk" PRIMARY KEY("chain_id","token_address"),
	CONSTRAINT "indexer_checkpoints_token_address_format" CHECK ("indexer_checkpoints"."token_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "indexer_checkpoints_last_block_hash_format" CHECK ("indexer_checkpoints"."last_block_hash" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"chain_id" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"block_timestamp" timestamp with time zone NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"token_address" text NOT NULL,
	"from_address" text NOT NULL,
	"to_address" text NOT NULL,
	"value" numeric(78, 0) NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfers_pk" PRIMARY KEY("chain_id","tx_hash","log_index"),
	CONSTRAINT "transfers_block_hash_format" CHECK ("transfers"."block_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "transfers_tx_hash_format" CHECK ("transfers"."tx_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "transfers_token_address_format" CHECK ("transfers"."token_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "transfers_from_address_format" CHECK ("transfers"."from_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "transfers_to_address_format" CHECK ("transfers"."to_address" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE INDEX "transfers_recent_idx" ON "transfers" USING btree ("chain_id","block_number" DESC NULLS FIRST,"log_index" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "transfers_from_idx" ON "transfers" USING btree ("chain_id","from_address","block_number" DESC NULLS FIRST,"log_index" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "transfers_to_idx" ON "transfers" USING btree ("chain_id","to_address","block_number" DESC NULLS FIRST,"log_index" DESC NULLS FIRST);