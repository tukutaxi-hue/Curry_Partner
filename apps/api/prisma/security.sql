-- Idempotent authorization layer for the runtime role `curry_app`.
-- Table owner `curry_owner` bypasses row-level security and is used only for migrations and seed.
-- Policies trust `app.user_id` and `app.role` set inside the API transaction.
-- Database credentials stay on the server. Clients never connect as these roles.

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO curry_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO curry_app;

REVOKE UPDATE, DELETE ON ledger_entries FROM curry_app;
REVOKE UPDATE, DELETE ON audit_logs FROM curry_app;
REVOKE UPDATE, DELETE ON stock_movements FROM curry_app;
REVOKE UPDATE ON commitment_status_events FROM curry_app;
REVOKE DELETE ON inspections FROM curry_app;
REVOKE UPDATE ON inspections FROM curry_app;
GRANT UPDATE (result, resolution_reason, resolved_at, resolved_by_id, resolved_quantity_kg) ON inspections TO curry_app;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_lots_available_nonnegative') THEN
    ALTER TABLE stock_lots
      ADD CONSTRAINT stock_lots_available_nonnegative
      CHECK (
        accepted_kg >= 0
        AND sold_kg >= 0
        AND waste_kg >= 0
        AND returned_kg >= 0
        AND (accepted_kg + adjustment_kg - sold_kg - waste_kg - returned_kg) >= 0
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commitments_quantity_positive') THEN
    ALTER TABLE commitments
      ADD CONSTRAINT commitments_quantity_positive CHECK (requested_quantity_kg > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledger_amount_nonnegative') THEN
    ALTER TABLE ledger_entries
      ADD CONSTRAINT ledger_amount_nonnegative CHECK (amount >= 0 AND accepted_quantity_kg >= 0 AND rate_per_kg >= 0);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION auth_get_user(p_phone text)
RETURNS TABLE (
  id text,
  role text,
  password_hash text,
  account_status text,
  must_change_password boolean,
  token_version integer,
  name text,
  phone text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.id, u.role::text, u.password_hash, u.account_status::text,
         u.must_change_password, u.token_version, u.name, u.phone
  FROM users u
  WHERE u.phone = p_phone
$$;

CREATE OR REPLACE FUNCTION session_by_refresh_hash(p_hash text)
RETURNS TABLE (
  session_id text,
  user_id text,
  expires_at timestamptz,
  revoked_at timestamptz,
  role text,
  account_status text,
  must_change_password boolean,
  token_version integer,
  name text,
  phone text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.id, s.user_id, s.expires_at, s.revoked_at,
         u.role::text, u.account_status::text, u.must_change_password,
         u.token_version, u.name, u.phone
  FROM sessions s
  JOIN users u ON u.id = s.user_id
  WHERE s.refresh_hash = p_hash
$$;

CREATE OR REPLACE FUNCTION lookup_onboarding(p_code text)
RETURNS TABLE (
  reference_code text,
  status text,
  admin_notes text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.reference_code,
         o.status::text,
         CASE WHEN o.status IN ('MORE_INFO', 'REJECTED') THEN o.admin_notes ELSE NULL END
  FROM onboarding_requests o
  WHERE o.reference_code = p_code
$$;

CREATE OR REPLACE FUNCTION onboarding_phone_blocked(p_phone text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM users u WHERE u.phone = p_phone)
      OR EXISTS (
        SELECT 1 FROM onboarding_requests o
        WHERE o.phone = p_phone AND o.status IN ('SUBMITTED', 'MORE_INFO')
      )
$$;

CREATE OR REPLACE FUNCTION enqueue_admin_notification(
  p_type text,
  p_title text,
  p_body text,
  p_dedupe text,
  p_data text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO notifications (id, user_id, type, title, body, data, dedupe_key, created_at)
  SELECT gen_random_uuid()::text, u.id, p_type, p_title, p_body, COALESCE(p_data::jsonb, '{}'::jsonb),
         p_dedupe || ':' || u.id, now()
  FROM users u
  WHERE u.role = 'ADMIN' AND u.account_status = 'ACTIVE'
  ON CONFLICT (user_id, dedupe_key) DO NOTHING;
END $$;

REVOKE ALL ON FUNCTION auth_get_user(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION session_by_refresh_hash(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION lookup_onboarding(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION onboarding_phone_blocked(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_admin_notification(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_get_user(text) TO curry_app;
GRANT EXECUTE ON FUNCTION session_by_refresh_hash(text) TO curry_app;
GRANT EXECUTE ON FUNCTION lookup_onboarding(text) TO curry_app;
GRANT EXECUTE ON FUNCTION onboarding_phone_blocked(text) TO curry_app;
GRANT EXECUTE ON FUNCTION enqueue_admin_notification(text, text, text, text, text) TO curry_app;

CREATE OR REPLACE FUNCTION users_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('app.role', true) = 'HOMEMAKER' THEN
    IF NEW.role IS DISTINCT FROM OLD.role
       OR NEW.account_status IS DISTINCT FROM OLD.account_status
       OR NEW.phone IS DISTINCT FROM OLD.phone
       OR NEW.is_demo IS DISTINCT FROM OLD.is_demo
    THEN
      RAISE EXCEPTION 'account fields are locked';
    END IF;
  END IF;
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash AND NEW.password_hash NOT LIKE '$argon2%' THEN
    RAISE EXCEPTION 'invalid password hash';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION commitments_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.homemaker_profile_id IS DISTINCT FROM OLD.homemaker_profile_id
     OR NEW.menu_item_id IS DISTINCT FROM OLD.menu_item_id
     OR NEW.service_date IS DISTINCT FROM OLD.service_date
     OR NEW.item_name IS DISTINCT FROM OLD.item_name
     OR NEW.rate_per_kg IS DISTINCT FROM OLD.rate_per_kg
     OR NEW.preparation_instructions IS DISTINCT FROM OLD.preparation_instructions
  THEN
    RAISE EXCEPTION 'commitment identity is immutable';
  END IF;
  IF current_setting('app.role', true) = 'HOMEMAKER' THEN
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
      (OLD.status = 'COMMITTED' AND NEW.status = 'PREPARING')
      OR (OLD.status = 'PREPARING' AND NEW.status = 'READY_FOR_COLLECTION')
    ) THEN
      RAISE EXCEPTION 'status change is not allowed';
    END IF;
    IF NEW.requested_quantity_kg IS DISTINCT FROM OLD.requested_quantity_kg AND OLD.status <> 'COMMITTED' THEN
      RAISE EXCEPTION 'quantity is locked';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION inspections_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.commitment_id IS DISTINCT FROM OLD.commitment_id
     OR NEW.weight_kg IS DISTINCT FROM OLD.weight_kg
     OR NEW.water_content IS DISTINCT FROM OLD.water_content
     OR NEW.freshness IS DISTINCT FROM OLD.freshness
     OR NEW.hygiene IS DISTINCT FROM OLD.hygiene
     OR NEW.notes IS DISTINCT FROM OLD.notes
     OR NEW.photo_url IS DISTINCT FROM OLD.photo_url
     OR NEW.accepted_quantity_kg IS DISTINCT FROM OLD.accepted_quantity_kg
     OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id
  THEN
    RAISE EXCEPTION 'inspection measurements are immutable';
  END IF;
  IF current_setting('app.role', true) = 'HOMEMAKER' THEN
    IF OLD.result NOT IN ('PASSED', 'FAILED') OR NEW.result <> 'DISPUTED' THEN
      RAISE EXCEPTION 'homemakers may only dispute an open inspection';
    END IF;
    IF NEW.resolved_at IS NOT NULL
       OR NEW.resolved_by_id IS NOT NULL
       OR NEW.resolution_reason IS DISTINCT FROM OLD.resolution_reason
       OR NEW.resolved_quantity_kg IS DISTINCT FROM OLD.resolved_quantity_kg
    THEN
      RAISE EXCEPTION 'resolution is admin only';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION ledger_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  matched boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'ledger entries are immutable';
  END IF;
  IF NEW.type = 'CREDIT' AND NEW.amount <> round(NEW.accepted_quantity_kg * NEW.rate_per_kg, 2) THEN
    RAISE EXCEPTION 'credit amount does not match quantity and rate';
  ELSIF NEW.type = 'REVERSAL' THEN
    SELECT EXISTS (
      SELECT 1 FROM ledger_entries e
      WHERE e.id = NEW.reverses_entry_id AND e.type = 'CREDIT' AND e.amount = NEW.amount
    ) INTO matched;
    IF NOT matched THEN
      RAISE EXCEPTION 'reversal must match a credit';
    END IF;
  ELSIF NEW.type = 'PAYOUT' THEN
    SELECT EXISTS (
      SELECT 1 FROM ledger_entries e
      WHERE e.id = NEW.settles_entry_id AND e.type = 'CREDIT' AND e.amount = NEW.amount
    ) INTO matched;
    IF NOT matched THEN
      RAISE EXCEPTION 'payout must match a credit';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION append_only_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'this record is append-only';
END $$;

DROP TRIGGER IF EXISTS users_guard ON users;
CREATE TRIGGER users_guard BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION users_guard();
DROP TRIGGER IF EXISTS commitments_guard ON commitments;
CREATE TRIGGER commitments_guard BEFORE UPDATE ON commitments FOR EACH ROW EXECUTE FUNCTION commitments_guard();
DROP TRIGGER IF EXISTS inspections_guard ON inspections;
CREATE TRIGGER inspections_guard BEFORE UPDATE ON inspections FOR EACH ROW EXECUTE FUNCTION inspections_guard();
DROP TRIGGER IF EXISTS ledger_guard ON ledger_entries;
CREATE TRIGGER ledger_guard BEFORE INSERT OR UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION ledger_guard();
DROP TRIGGER IF EXISTS audit_append_only ON audit_logs;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION append_only_guard();
DROP TRIGGER IF EXISTS movement_append_only ON stock_movements;
CREATE TRIGGER movement_append_only BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION append_only_guard();
DROP TRIGGER IF EXISTS status_event_append_only ON commitment_status_events;
CREATE TRIGGER status_event_append_only BEFORE UPDATE ON commitment_status_events FOR EACH ROW EXECUTE FUNCTION append_only_guard();

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_areas ENABLE ROW LEVEL SECURITY;
ALTER TABLE stalls ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE homemaker_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_menus ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE commitments ENABLE ROW LEVEL SECURITY;
ALTER TABLE commitment_status_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspections ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_item_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_admin ON users;
CREATE POLICY users_admin ON users FOR ALL
  USING (current_setting('app.role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.role', true) = 'ADMIN');
DROP POLICY IF EXISTS users_self_select ON users;
CREATE POLICY users_self_select ON users FOR SELECT
  USING (current_setting('app.role', true) = 'HOMEMAKER' AND id = current_setting('app.user_id', true));
DROP POLICY IF EXISTS users_self_update ON users;
CREATE POLICY users_self_update ON users FOR UPDATE
  USING (current_setting('app.role', true) = 'HOMEMAKER' AND id = current_setting('app.user_id', true))
  WITH CHECK (current_setting('app.role', true) = 'HOMEMAKER' AND id = current_setting('app.user_id', true) AND role = 'HOMEMAKER');

DROP POLICY IF EXISTS sessions_admin ON sessions;
CREATE POLICY sessions_admin ON sessions FOR ALL
  USING (current_setting('app.role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.role', true) = 'ADMIN');
DROP POLICY IF EXISTS sessions_insert_login ON sessions;
CREATE POLICY sessions_insert_login ON sessions FOR INSERT
  WITH CHECK (current_setting('app.role', true) IN ('PUBLIC', 'HOMEMAKER', 'ADMIN'));
DROP POLICY IF EXISTS sessions_self_select ON sessions;
CREATE POLICY sessions_self_select ON sessions FOR SELECT
  USING (user_id = current_setting('app.user_id', true));
DROP POLICY IF EXISTS sessions_self_update ON sessions;
CREATE POLICY sessions_self_update ON sessions FOR UPDATE
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS areas_admin ON service_areas;
CREATE POLICY areas_admin ON service_areas FOR ALL
  USING (current_setting('app.role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.role', true) = 'ADMIN');
DROP POLICY IF EXISTS areas_read ON service_areas;
CREATE POLICY areas_read ON service_areas FOR SELECT
  USING (active = true AND current_setting('app.role', true) IN ('PUBLIC', 'HOMEMAKER'));

DROP POLICY IF EXISTS stalls_admin ON stalls;
CREATE POLICY stalls_admin ON stalls FOR ALL
  USING (current_setting('app.role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.role', true) = 'ADMIN');

DROP POLICY IF EXISTS onboarding_admin ON onboarding_requests;
CREATE POLICY onboarding_admin ON onboarding_requests FOR ALL
  USING (current_setting('app.role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.role', true) = 'ADMIN');
DROP POLICY IF EXISTS onboarding_submit ON onboarding_requests;
CREATE POLICY onboarding_submit ON onboarding_requests FOR INSERT
  WITH CHECK (
    current_setting('app.role', true) = 'PUBLIC'
    AND status = 'SUBMITTED'
    AND agreement_acknowledged = true
  );

DROP POLICY IF EXISTS profiles_admin ON homemaker_profiles;
CREATE POLICY profiles_admin ON homemaker_profiles FOR ALL
  USING (current_setting('app.role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.role', true) = 'ADMIN');
DROP POLICY IF EXISTS profiles_self ON homemaker_profiles;
CREATE POLICY profiles_self ON homemaker_profiles FOR SELECT
  USING (current_setting('app.role', true) = 'HOMEMAKER' AND user_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS settings_admin ON platform_settings;
CREATE POLICY settings_admin ON platform_settings FOR ALL
  USING (current_setting('app.role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.role', true) = 'ADMIN');
DROP POLICY IF EXISTS settings_read ON platform_settings;
CREATE POLICY settings_read ON platform_settings FOR SELECT
  USING (current_setting('app.role', true) IN ('PUBLIC', 'HOMEMAKER', 'ADMIN'));

DROP POLICY IF EXISTS menus_admin ON daily_menus;
CREATE POLICY menus_admin ON daily_menus FOR ALL
  USING (current_setting('app.role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.role', true) = 'ADMIN');
DROP POLICY IF EXISTS menus_homemaker ON daily_menus;
CREATE POLICY menus_homemaker ON daily_menus FOR SELECT
  USING (
    current_setting('app.role', true) = 'HOMEMAKER'
    AND status = 'PUBLISHED'
    AND service_area_id IN (
      SELECT service_area_id FROM homemaker_profiles WHERE user_id = current_setting('app.user_id', true)
    )
  );

DROP POLICY IF EXISTS items_admin ON menu_items;
CREATE POLICY items_admin ON menu_items FOR ALL
  USING (current_setting('app.role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.role', true) = 'ADMIN');
DROP POLICY IF EXISTS items_homemaker ON menu_items;
CREATE POLICY items_homemaker ON menu_items FOR SELECT
  USING (
    current_setting('app.role', true) = 'HOMEMAKER'
    AND EXISTS (
      SELECT 1 FROM daily_menus m
      JOIN homemaker_profiles p ON p.service_area_id = m.service_area_id
      WHERE m.id = menu_items.menu_id
        AND m.status = 'PUBLISHED'
        AND p.user_id = current_setting('app.user_id', true)
    )
  );

DROP POLICY IF EXISTS commitments_admin ON commitments;
CREATE POLICY commitments_admin ON commitments FOR ALL
  USING (current_setting('app.role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.role', true) = 'ADMIN');
DROP POLICY IF EXISTS commitments_homemaker_select ON commitments;
CREATE POLICY commitments_homemaker_select ON commitments FOR SELECT
  USING (
    current_setting('app.role', true) = 'HOMEMAKER'
    AND EXISTS (
      SELECT 1 FROM homemaker_profiles p
      WHERE p.id = commitments.homemaker_profile_id
        AND p.user_id = current_setting('app.user_id', true)
    )
  );
DROP POLICY IF EXISTS commitments_homemaker_insert ON commitments;
CREATE POLICY commitments_homemaker_insert ON commitments FOR INSERT
  WITH CHECK (
    current_setting('app.role', true) = 'HOMEMAKER'
    AND status = 'COMMITTED'
    AND EXISTS (
      SELECT 1 FROM homemaker_profiles p
      JOIN menu_items mi ON mi.id = commitments.menu_item_id
      JOIN daily_menus m ON m.id = mi.menu_id
      WHERE p.id = commitments.homemaker_profile_id
        AND p.user_id = current_setting('app.user_id', true)
        AND p.service_area_id = m.service_area_id
        AND m.status = 'PUBLISHED'
    )
  );
DROP POLICY IF EXISTS commitments_homemaker_update ON commitments;
CREATE POLICY commitments_homemaker_update ON commitments FOR UPDATE
  USING (
    current_setting('app.role', true) = 'HOMEMAKER'
    AND EXISTS (
      SELECT 1 FROM homemaker_profiles p
      WHERE p.id = commitments.homemaker_profile_id
        AND p.user_id = current_setting('app.user_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.role', true) = 'HOMEMAKER'
    AND EXISTS (
      SELECT 1 FROM homemaker_profiles p
      WHERE p.id = commitments.homemaker_profile_id
        AND p.user_id = current_setting('app.user_id', true)
    )
  );
DROP POLICY IF EXISTS commitments_homemaker_delete ON commitments;
CREATE POLICY commitments_homemaker_delete ON commitments FOR DELETE
  USING (
    current_setting('app.role', true) = 'HOMEMAKER'
    AND status = 'COMMITTED'
    AND EXISTS (
      SELECT 1 FROM homemaker_profiles p
      WHERE p.id = commitments.homemaker_profile_id
        AND p.user_id = current_setting('app.user_id', true)
    )
  );

DROP POLICY IF EXISTS events_admin ON commitment_status_events;
CREATE POLICY events_admin ON commitment_status_events FOR ALL
  USING (current_setting('app.role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.role', true) = 'ADMIN');
DROP POLICY IF EXISTS events_homemaker ON commitment_status_events;
CREATE POLICY events_homemaker ON commitment_status_events FOR ALL
  USING (
    current_setting('app.role', true) = 'HOMEMAKER'
    AND EXISTS (
      SELECT 1 FROM commitments c
      JOIN homemaker_profiles p ON p.id = c.homemaker_profile_id
      WHERE c.id = commitment_status_events.commitment_id
        AND p.user_id = current_setting('app.user_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.role', true) = 'HOMEMAKER'
    AND EXISTS (
      SELECT 1 FROM commitments c
      JOIN homemaker_profiles p ON p.id = c.homemaker_profile_id
      WHERE c.id = commitment_status_events.commitment_id
        AND p.user_id = current_setting('app.user_id', true)
    )
  );

DROP POLICY IF EXISTS collection_admin ON collection_records;
CREATE POLICY collection_admin ON collection_records FOR ALL
  USING (current_setting('app.role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.role', true) = 'ADMIN');
DROP POLICY IF EXISTS collection_homemaker ON collection_records;
CREATE POLICY collection_homemaker ON collection_records FOR SELECT
  USING (
    current_setting('app.role', true) = 'HOMEMAKER'
    AND EXISTS (
      SELECT 1 FROM commitments c
      JOIN homemaker_profiles p ON p.id = c.homemaker_profile_id
      WHERE c.id = collection_records.commitment_id
        AND p.user_id = current_setting('app.user_id', true)
    )
  );

DROP POLICY IF EXISTS inspections_admin ON inspections;
CREATE POLICY inspections_admin ON inspections FOR ALL
  USING (current_setting('app.role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.role', true) = 'ADMIN');
DROP POLICY IF EXISTS inspections_homemaker_select ON inspections;
CREATE POLICY inspections_homemaker_select ON inspections FOR SELECT
  USING (
    current_setting('app.role', true) = 'HOMEMAKER'
    AND EXISTS (
      SELECT 1 FROM commitments c
      JOIN homemaker_profiles p ON p.id = c.homemaker_profile_id
      WHERE c.id = inspections.commitment_id AND p.user_id = current_setting('app.user_id', true)
    )
  );
DROP POLICY IF EXISTS inspections_homemaker_dispute ON inspections;
CREATE POLICY inspections_homemaker_dispute ON inspections FOR UPDATE
  USING (
    current_setting('app.role', true) = 'HOMEMAKER'
    AND EXISTS (
      SELECT 1 FROM commitments c
      JOIN homemaker_profiles p ON p.id = c.homemaker_profile_id
      WHERE c.id = inspections.commitment_id AND p.user_id = current_setting('app.user_id', true)
    )
  )
  WITH CHECK (current_setting('app.role', true) = 'HOMEMAKER' AND result = 'DISPUTED');

DROP POLICY IF EXISTS stock_admin ON stock_lots;
CREATE POLICY stock_admin ON stock_lots FOR ALL
  USING (current_setting('app.role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.role', true) = 'ADMIN');
DROP POLICY IF EXISTS movements_admin ON stock_movements;
CREATE POLICY movements_admin ON stock_movements FOR ALL
  USING (current_setting('app.role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.role', true) = 'ADMIN');

DROP POLICY IF EXISTS ledger_admin ON ledger_entries;
CREATE POLICY ledger_admin ON ledger_entries FOR ALL
  USING (current_setting('app.role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.role', true) = 'ADMIN');
DROP POLICY IF EXISTS ledger_homemaker_select ON ledger_entries;
CREATE POLICY ledger_homemaker_select ON ledger_entries FOR SELECT
  USING (
    current_setting('app.role', true) = 'HOMEMAKER'
    AND EXISTS (
      SELECT 1 FROM homemaker_profiles p
      WHERE p.id = ledger_entries.homemaker_profile_id
        AND p.user_id = current_setting('app.user_id', true)
    )
  );
DROP POLICY IF EXISTS ledger_homemaker_reversal ON ledger_entries;
CREATE POLICY ledger_homemaker_reversal ON ledger_entries FOR INSERT
  WITH CHECK (
    current_setting('app.role', true) = 'HOMEMAKER'
    AND type = 'REVERSAL'
    AND EXISTS (
      SELECT 1 FROM homemaker_profiles p
      WHERE p.id = ledger_entries.homemaker_profile_id
        AND p.user_id = current_setting('app.user_id', true)
    )
  );

DROP POLICY IF EXISTS payouts_admin ON payout_batches;
CREATE POLICY payouts_admin ON payout_batches FOR ALL
  USING (current_setting('app.role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.role', true) = 'ADMIN');
DROP POLICY IF EXISTS payout_items_admin ON payout_items;
CREATE POLICY payout_items_admin ON payout_items FOR ALL
  USING (current_setting('app.role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.role', true) = 'ADMIN');
DROP POLICY IF EXISTS payout_links_admin ON payout_item_credits;
CREATE POLICY payout_links_admin ON payout_item_credits FOR ALL
  USING (current_setting('app.role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.role', true) = 'ADMIN');

DROP POLICY IF EXISTS notifications_admin ON notifications;
CREATE POLICY notifications_admin ON notifications FOR ALL
  USING (current_setting('app.role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.role', true) = 'ADMIN');
DROP POLICY IF EXISTS notifications_self ON notifications;
CREATE POLICY notifications_self ON notifications FOR ALL
  USING (current_setting('app.role', true) = 'HOMEMAKER' AND user_id = current_setting('app.user_id', true))
  WITH CHECK (current_setting('app.role', true) = 'HOMEMAKER' AND user_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS audit_admin_select ON audit_logs;
CREATE POLICY audit_admin_select ON audit_logs FOR SELECT
  USING (current_setting('app.role', true) = 'ADMIN');
DROP POLICY IF EXISTS audit_insert ON audit_logs;
CREATE POLICY audit_insert ON audit_logs FOR INSERT
  WITH CHECK (
    current_setting('app.role', true) = 'ADMIN'
    OR (current_setting('app.role', true) = 'HOMEMAKER' AND actor_id = current_setting('app.user_id', true))
    OR (
      current_setting('app.role', true) = 'PUBLIC'
      AND actor_id IS NULL
      AND action IN ('auth.login_failed', 'onboarding.submit')
    )
  );

DROP POLICY IF EXISTS idempotency_admin ON idempotency_keys;
CREATE POLICY idempotency_admin ON idempotency_keys FOR ALL
  USING (current_setting('app.role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.role', true) = 'ADMIN');
DROP POLICY IF EXISTS idempotency_self ON idempotency_keys;
CREATE POLICY idempotency_self ON idempotency_keys FOR ALL
  USING (current_setting('app.role', true) = 'HOMEMAKER' AND user_id = current_setting('app.user_id', true))
  WITH CHECK (current_setting('app.role', true) = 'HOMEMAKER' AND user_id = current_setting('app.user_id', true));
