-- Optional D1 schema for the Signer (INV-SEC-5, INV-SEC-7, INV-PRIV-5).
--
-- WHAT IS IN HERE: counters, timestamps, and KEYED TAGS. No audio, no
-- transcripts, no email, no address, and nothing an attacker holding a dump of
-- this database can turn back into a person.
--
-- Every identifier below is HMAC(Secret, value) truncated to 64 bits, not a
-- plain hash. That distinction is the whole protection: an IPv4 address is 32
-- bits and a studentRef is a 30-bit id, so a PLAIN hash of either is invertible
-- by enumerating the domain — which is what an earlier version of this schema
-- stored while claiming otherwise (audit 2026-08-21, findings F-1 and F-2). The
-- Secret lives only in the Signer env (INV-SEC-4), so the Worker can recompute a
-- tag to look a row up and nobody else can go the other way.
--
-- WHAT IS DELIBERATELY ABSENT: anything about a student's DRC / disability
-- accommodation (INV-ACCOM-3). The Signer is told a claimed time multiplier so
-- it can compute a deadline — that is unavoidable, because the deadline is
-- enforced server-side — but it is used and dropped. It is NEVER written to any
-- table here, never derived into any key or tag, and never logged. It exists at
-- rest in exactly one place: the signed Certificate, which travels with the
-- student's own submission into Gradescope, which is already the system of
-- record for their accommodation.
--
-- Adding an accommodation column here would be a privacy regression, not a
-- feature. `t_accommodation_not_persisted` fails the build if anyone tries.
CREATE TABLE IF NOT EXISTS rl (
  k  TEXT    NOT NULL,   -- "ip:<tag16>" or "sref:<tag16>" -- NEVER a raw address
  ts INTEGER NOT NULL    -- unix seconds
);
CREATE INDEX IF NOT EXISTS rl_k_ts ON rl (k, ts);

-- Retake cooldown (INV-SEC-7): one row per student+assignment, so a student who
-- abandons a question they just saw cannot immediately reroll for an easier one.
-- `finished` flips to 1 once /finish issued a Certificate, which clears the
-- cooldown at once — answering is never penalised, only shopping is.
--
-- RETENTION: a row is useful for exactly `retakeCooldownSec` (minutes). Kept
-- longer it becomes a permanent record that this pseudonymous student opened
-- this assignment at this time, which is more than the cooldown needs and more
-- than INV-PRIV-5 allows. Rows older than a day are swept on write.
CREATE TABLE IF NOT EXISTS attempt (
  k          TEXT    PRIMARY KEY,  -- "att:<tag16 of studentRef|assignmentId>"
  attempt_id TEXT    NOT NULL,
  t_reveal   INTEGER NOT NULL,     -- unix seconds
  finished   INTEGER NOT NULL      -- 1 once certified
);
CREATE INDEX IF NOT EXISTS attempt_ts ON attempt (t_reveal);

-- Access-attempt log (INV-SEC-9): every /reveal decision, so a bank-mining
-- attempt is visible and not merely blocked. A burst of KEY_INVALID rows from
-- one ip_hash is someone guessing keys; it also drives the 15-minute lockout.
-- No PII: the identity is already opaque (INV-PRIV-2) and is KEY-tagged again
-- here, and the address exists only as a keyed tag. Rows expire after 7 days.
CREATE TABLE IF NOT EXISTS access_log (
  ts         INTEGER NOT NULL,   -- unix seconds
  event      TEXT    NOT NULL,   -- "granted" | "denied"
  reason     TEXT    NOT NULL,   -- accessKey | quizToken | key-not-required | KEY_REQUIRED | KEY_INVALID | KEY_LOCKED
  ref_hash   TEXT    NOT NULL,   -- HMAC(Secret, studentRef), 64 bits
  ip_hash    TEXT    NOT NULL,   -- HMAC(Secret, address), 64 bits
  assignment TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS access_log_ts ON access_log (ts);
CREATE INDEX IF NOT EXISTS access_log_ref ON access_log (ref_hash, ts);
CREATE INDEX IF NOT EXISTS access_log_ip ON access_log (ip_hash, ts);
