-- UI1 #205: the pharmacy brand, one row per tenant, set by an owner. No row = PharmaCeylon defaults.
CREATE TABLE "tenant_appearance" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "accent" VARCHAR(7) NOT NULL,
    "sidebar_style" VARCHAR(16) NOT NULL,
    "chart_palette" VARCHAR(16) NOT NULL,
    "status_set" VARCHAR(16) NOT NULL,
    "counter_theme" VARCHAR(16) NOT NULL,
    "counter_theme_locked" BOOLEAN NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_appearance_pkey" PRIMARY KEY ("id"),
    -- Backstops for the shared validator; contrast itself is checked in code.
    CONSTRAINT "tenant_appearance_accent_shape" CHECK ("accent" ~ '^#[0-9a-f]{6}$'),
    CONSTRAINT "tenant_appearance_sidebar_style" CHECK ("sidebar_style" IN ('light', 'tinted', 'dark')),
    CONSTRAINT "tenant_appearance_chart_palette" CHECK ("chart_palette" IN ('accent', 'distinct')),
    CONSTRAINT "tenant_appearance_status_set" CHECK ("status_set" IN ('standard', 'colour-blind')),
    CONSTRAINT "tenant_appearance_counter_theme" CHECK ("counter_theme" IN ('system', 'light', 'dark')),
    CONSTRAINT "tenant_appearance_version_positive" CHECK ("version" >= 1)
);

CREATE UNIQUE INDEX "tenant_appearance_tenant_id_key" ON "tenant_appearance"("tenant_id");

ALTER TABLE "tenant_appearance" ADD CONSTRAINT "tenant_appearance_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Staged tenant isolation, disabled like every other table's until the controlled rollout.
CREATE POLICY pc_tenant_isolation ON tenant_appearance
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
