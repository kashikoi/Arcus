/* Arcus — unified Kashikoi backup + zero-knowledge encrypted cloud sync (shared suite worker). No DOM. */
(function (A) {
  "use strict";

  const CLOUD_SYNC_ENDPOINT = "https://nimbus-sync.nimbus-sync.workers.dev";
  const CLOUD_SYNC_FORMAT = "kashikoi-encrypted-backup-v1";
  const LEGACY_CLOUD_SYNC_FORMAT = "nimbus-encrypted-backup-v1";
  const UNIFIED_BACKUP_SCHEMA = "kashikoi-app-backup-v1";
  // The shared Worker only accepts envelopes tagged "Nimbus"/"Cumulus"; every suite app reads/writes the same
  // blob, so Arcus tags it "Nimbus" (author recorded in `writtenBy`) and each app keeps its own slice in `apps`.
  const CLOUD_ENVELOPE_APP = "Nimbus";
  const ACCEPTED_ENVELOPE_APPS = new Set(["Nimbus", "Cumulus", "Cirrus", "Stratus", "Anvil", "Arcus"]);
  const RECOVERY_PHRASE_WORD_COUNT = 16;
  const CLOUD_KDF_ITERATIONS = 600000;
  const RECOVERY_WORDS = [
    "anchor", "apricot", "arbor", "aurora", "basalt", "beacon", "birch", "bison",
    "blossom", "boulder", "breeze", "canyon", "cedar", "cinder", "cirrus", "clay",
    "clover", "cobalt", "comet", "coral", "cove", "crater", "crystal", "cumulus",
    "current", "dawn", "delta", "dune", "ember", "evergreen", "fathom", "fern",
    "fjord", "flint", "forge", "fossil", "galaxy", "garnet", "geyser", "glacier",
    "granite", "grove", "harbor", "hazel", "heather", "horizon", "ivory", "jade",
    "juniper", "kelp", "lagoon", "lantern", "lichen", "lilac", "lumen", "magma",
    "maple", "marble", "meadow", "meridian", "mesa", "mica", "mist", "monsoon",
    "moss", "nebula", "nectar", "oasis", "obsidian", "ocean", "onyx", "opal",
    "orchard", "pebble", "petal", "pine", "pollen", "prairie", "quartz", "quill",
    "rapids", "ravine", "reef", "ridge", "ripple", "river", "sable", "saffron",
    "sage", "sandbar", "sapphire", "savanna", "sequoia", "shale", "shore", "sierra",
    "slate", "solstice", "spruce", "storm", "summit", "tempest", "thicket", "thunder",
    "tide", "timber", "topaz", "trellis", "tundra", "valley", "vapor", "verdant",
    "vertex", "vista", "willow", "wisp", "zenith", "zephyr",
  ];

  // ---------- Unified backup ----------
  function arcusSlice(db, theme) {
    return Object.assign({ version: 2, appName: "Arcus", exportedAt: new Date().toISOString(), theme }, db);
  }
  function existingApps(existing) {
    if (!existing || typeof existing !== "object") return {};
    if (existing.schema === UNIFIED_BACKUP_SCHEMA && existing.apps && typeof existing.apps === "object") return Object.assign({}, existing.apps);
    if (existing.appName === "Nimbus" || Array.isArray(existing.tabs)) return { nimbus: existing };
    if (existing.appName === "Cumulus" || Array.isArray(existing.accounts)) return { cumulus: existing };
    if (existing.appName === "Cirrus" || Array.isArray(existing.movies)) return { cirrus: existing };
    if (existing.appName === "Stratus" || Array.isArray(existing.stamps)) return { stratus: existing };
    if (existing.appName === "Anvil" || Array.isArray(existing.runbooks)) return { anvil: existing };
    if (existing.appName === "Arcus" || Array.isArray(existing.goals)) return { arcus: existing };
    return {};
  }
  // Preserves every sibling app's slice; only Arcus's slice is replaced.
  function createBackupData(db, theme, existing) {
    const apps = existingApps(existing);
    apps.arcus = arcusSlice(db, theme);
    return { schema: UNIFIED_BACKUP_SCHEMA, version: 1, appName: "Kashikoi Apps", exportedAt: new Date().toISOString(), apps };
  }
  // Accepts a unified backup or a bare Arcus slice (v1 or v2). Throws if there's no Arcus data.
  function readBackup(data) {
    if (!data || typeof data !== "object") throw new Error("Invalid format");
    const slice = data.schema === UNIFIED_BACKUP_SCHEMA && data.apps ? data.apps.arcus : data;
    if (!slice || typeof slice !== "object" || !Array.isArray(slice.goals)) throw new Error("No Arcus data");
    return { db: A.model.normalizeDb(slice), theme: typeof slice.theme === "string" ? slice.theme : null };
  }

  // ---------- Crypto ----------
  function createRecoveryPhrase() {
    const idx = new Uint32Array(RECOVERY_PHRASE_WORD_COUNT);
    crypto.getRandomValues(idx);
    return Array.from(idx).map((n) => RECOVERY_WORDS[n % RECOVERY_WORDS.length]).join(" ");
  }
  function b64(buffer) {
    const bytes = new Uint8Array(buffer);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function unb64(s) {
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  async function sha256Hex(value) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function syncKey(phrase) { return sha256Hex("kashikoi-cloud-sync-v1:" + phrase); }
  async function deriveKey(phrase, salt) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(phrase), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: CLOUD_KDF_ITERATIONS }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function encrypt(phrase, data) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(phrase, salt);
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(data)));
    return {
      app: CLOUD_ENVELOPE_APP, writtenBy: "Arcus", format: CLOUD_SYNC_FORMAT, updatedAt: new Date().toISOString(),
      kdf: { name: "PBKDF2", hash: "SHA-256", iterations: CLOUD_KDF_ITERATIONS, salt: b64(salt) },
      cipher: { name: "AES-GCM", iv: b64(iv) },
      payload: b64(encrypted),
    };
  }
  async function decrypt(phrase, env) {
    if (!env || typeof env !== "object" || !ACCEPTED_ENVELOPE_APPS.has(env.app) ||
        (env.format !== CLOUD_SYNC_FORMAT && env.format !== LEGACY_CLOUD_SYNC_FORMAT) ||
        !env.kdf || !env.cipher || typeof env.payload !== "string") throw new Error("Invalid envelope");
    const key = await deriveKey(phrase, new Uint8Array(unb64(env.kdf.salt)));
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(unb64(env.cipher.iv)) }, key, unb64(env.payload));
    return JSON.parse(new TextDecoder().decode(plain));
  }
  async function fetchEnvelope(key) {
    const bust = Date.now() + "-" + Math.random().toString(36).slice(2);
    const res = await fetch(`${CLOUD_SYNC_ENDPOINT}/sync/${key}?t=${bust}`, { cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  // Merge-save: decrypt what's there, replace only Arcus's slice, re-encrypt, PUT.
  async function saveToCloud(phrase, db, theme) {
    const key = await syncKey(phrase);
    const env = await fetchEnvelope(key);
    let existing = null;
    if (env) {
      try { existing = await decrypt(phrase, env); }
      catch (e) { const err = new Error("decrypt-existing"); err.code = "decrypt-existing"; throw err; }
    }
    const envelope = await encrypt(phrase, createBackupData(db, theme, existing));
    const res = await fetch(`${CLOUD_SYNC_ENDPOINT}/sync/${key}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(envelope) });
    if (!res.ok) throw new Error("HTTP " + res.status);
  }
  // Returns decrypted unified backup, or null if nothing is stored for this phrase.
  async function loadFromCloud(phrase) {
    const env = await fetchEnvelope(await syncKey(phrase));
    return env ? decrypt(phrase, env) : null;
  }

  A.sync = { createBackupData, readBackup, createRecoveryPhrase, saveToCloud, loadFromCloud, RECOVERY_PHRASE_WORD_COUNT };
})(typeof window !== "undefined" ? window.Arcus : globalThis.Arcus);
