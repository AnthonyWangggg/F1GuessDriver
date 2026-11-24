-- Add defaults in two steps: pre-upgrade rows (including unfinished series) lock v1.
ALTER TABLE bo3_series ADD COLUMN points_policy_version text NOT NULL DEFAULT 'bo3-points-eligibility-v1';
ALTER TABLE bo3_series ALTER COLUMN points_policy_version SET DEFAULT 'bo3-points-eligibility-v2';
ALTER TABLE bo3_series ADD COLUMN points_eligibility text;
ALTER TABLE bo3_series ADD COLUMN points_ineligible_reason text;
ALTER TABLE bo3_series ADD COLUMN participation0 integer;
ALTER TABLE bo3_series ADD COLUMN participation1 integer;
ALTER TABLE bo3_series ADD COLUMN points_decided_at timestamptz;
ALTER TABLE bo3_series ADD CONSTRAINT bo3_points_policy_check CHECK(points_policy_version IN ('bo3-points-eligibility-v1','bo3-points-eligibility-v2'));
ALTER TABLE bo3_series ADD CONSTRAINT bo3_points_decision_check CHECK(
 (points_policy_version='bo3-points-eligibility-v1' AND points_eligibility IS NULL AND points_ineligible_reason IS NULL AND participation0 IS NULL AND participation1 IS NULL AND points_decided_at IS NULL)
 OR (points_policy_version='bo3-points-eligibility-v2' AND (
  (status='active' AND points_eligibility IS NULL AND points_ineligible_reason IS NULL AND participation0 IS NULL AND participation1 IS NULL AND points_decided_at IS NULL)
  OR (status='finished' AND points_decided_at IS NOT NULL AND participation0 IS NOT NULL AND participation1 IS NOT NULL AND participation0>=0 AND participation1>=0 AND (
   (points_eligibility IS NOT NULL AND points_eligibility='ineligible' AND participation0=0 AND participation1=0 AND points_ineligible_reason IS NOT NULL AND points_ineligible_reason='both-zero-participation')
   OR (points_eligibility IS NOT NULL AND points_eligibility='eligible' AND participation0+participation1>0 AND points_ineligible_reason IS NULL)
  ))
 )));
--> statement-breakpoint
-- Only persisted, accepted events count. Guesses must have a matching saved guess.
-- Surrender is the authoritative result event, already unique per round.
CREATE FUNCTION bo3_participation(sid uuid) RETURNS TABLE(slot integer, events integer) LANGUAGE sql STABLE AS $$
 SELECT p.slot,count(e.seq)::integer FROM bo3_players p LEFT JOIN bo3_events e ON e.series_id=p.series_id AND (
  (e.kind='heartbeat' AND e.payload->>'slot'=p.slot::text)
  OR (e.kind='guess' AND e.payload->>'slot'=p.slot::text AND EXISTS(
   SELECT 1 FROM bo3_guesses g JOIN bo3_rounds r ON r.id=g.round_id
   WHERE r.series_id=p.series_id AND g.round_id=e.round_id AND g.principal_id=p.principal_id AND g.event_seq=e.seq))
  OR (e.kind='result' AND e.payload->>'reason'='surrender' AND e.payload->>'winnerSlot'=(1-p.slot)::text)
 ) WHERE p.series_id=sid GROUP BY p.slot ORDER BY p.slot;
$$;
CREATE FUNCTION bo3_points_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c0 integer; c1 integer;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.points_policy_version<>'bo3-points-eligibility-v2' OR NEW.status<>'active' THEN RAISE EXCEPTION 'new BO3 requires current eligibility policy'; END IF;
 ELSE
  IF NEW.points_policy_version<>OLD.points_policy_version THEN RAISE EXCEPTION 'immutable BO3 points policy'; END IF;
 END IF;
 IF NEW.points_policy_version='bo3-points-eligibility-v2' AND NEW.status='finished' THEN
  SELECT events INTO c0 FROM bo3_participation(NEW.id) WHERE slot=0;
  SELECT events INTO c1 FROM bo3_participation(NEW.id) WHERE slot=1;
  IF c0 IS NULL OR c1 IS NULL OR NEW.participation0 IS DISTINCT FROM c0 OR NEW.participation1 IS DISTINCT FROM c1 THEN RAISE EXCEPTION 'BO3 participation evidence mismatch'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bo3_points_guard BEFORE INSERT OR UPDATE ON bo3_series FOR EACH ROW EXECUTE FUNCTION bo3_points_guard();
--> statement-breakpoint
CREATE FUNCTION bo3_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state text;
BEGIN
 SELECT status INTO state FROM bo3_series WHERE id=NEW.series_id FOR UPDATE;
 IF state IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'BO3 events require active series'; END IF;
 IF NEW.round_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM bo3_rounds WHERE id=NEW.round_id AND series_id=NEW.series_id) THEN RAISE EXCEPTION 'BO3 event round mismatch'; END IF;
 IF NEW.kind IN ('heartbeat','guess') AND (NEW.payload->>'slot' IS NULL OR NEW.payload->>'slot' NOT IN ('0','1')) THEN RAISE EXCEPTION 'BO3 participant slot required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bo3_event_guard BEFORE INSERT ON bo3_events FOR EACH ROW EXECUTE FUNCTION bo3_event_guard();
CREATE FUNCTION bo3_ledger_eligibility_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source_kind='match-v2-bo3' AND NOT EXISTS(
  SELECT 1 FROM bo3_series WHERE id=NEW.bo3_series_id AND status='finished' AND
   (points_policy_version='bo3-points-eligibility-v1' OR points_eligibility='eligible')
 ) THEN RAISE EXCEPTION 'BO3 is not points eligible'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bo3_ledger_eligibility_guard BEFORE INSERT ON points_ledger FOR EACH ROW EXECUTE FUNCTION bo3_ledger_eligibility_guard();
--> statement-breakpoint
-- Deferred: the immutable series transition precedes ledger inserts in the same tx.
CREATE FUNCTION bo3_terminal_points_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s bo3_series%ROWTYPE; n integer;
BEGIN
 SELECT * INTO s FROM bo3_series WHERE id=NEW.id;
 IF s.status<>'finished' OR s.points_policy_version<>'bo3-points-eligibility-v2' THEN RETURN NULL; END IF;
 SELECT count(*) INTO n FROM points_ledger WHERE bo3_series_id=s.id;
 IF s.points_eligibility='ineligible' THEN
  IF n<>0 THEN RAISE EXCEPTION 'ineligible BO3 must have no rewards'; END IF;
 ELSE
  IF n<>2 OR EXISTS(SELECT 1 FROM bo3_players p WHERE p.series_id=s.id AND NOT EXISTS(
   SELECT 1 FROM points_ledger l WHERE l.bo3_series_id=s.id AND l.principal_id=p.principal_id
    AND l.source_kind='match-v2-bo3' AND l.rule_version='points-v1'
    AND l.nominal_delta=CASE WHEN p.slot=s.winner_slot THEN 3 ELSE -1 END
    AND l.reward_kind=CASE WHEN p.slot=s.winner_slot THEN 'win' ELSE 'loss' END
  )) THEN RAISE EXCEPTION 'eligible BO3 requires both legal rewards'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bo3_terminal_points_check AFTER INSERT OR UPDATE ON bo3_series DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status='finished') EXECUTE FUNCTION bo3_terminal_points_check();
