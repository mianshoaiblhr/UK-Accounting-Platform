-- V1-M8h (DEC-046): a customer's default VAT code. Optional; a VAT code of the same organisation that a sales line may use
-- (direction SALES or BOTH, not reverse charge). Invoice lines copy it when written, so a later change never alters a document.
ALTER TABLE "customer_profile" ADD COLUMN "default_tax_code_id" UUID;
ALTER TABLE "customer_profile" ADD CONSTRAINT "customer_profile_tax_code_fkey" FOREIGN KEY ("organisation_id", "default_tax_code_id") REFERENCES "tax_code"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION customer_default_tax_code_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d TEXT; rc BOOLEAN;
BEGIN
  IF NEW.default_tax_code_id IS NULL THEN RETURN NEW; END IF;
  SELECT direction, reverse_charge INTO d, rc FROM tax_code WHERE id = NEW.default_tax_code_id AND organisation_id = NEW.organisation_id;
  IF d IS NULL OR d NOT IN ('SALES', 'BOTH') OR rc THEN
    RAISE EXCEPTION 'a customer''s default VAT code must be a sales code that is not reverse charge' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_default_tax_code_trg BEFORE INSERT OR UPDATE OF default_tax_code_id ON customer_profile FOR EACH ROW EXECUTE FUNCTION customer_default_tax_code_guard();
