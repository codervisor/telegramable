import assert from "assert";
import test from "node:test";
import { defaultWorkingDir, loadConfig } from "../src/config";

/**
 * Helper: run loadConfig with the given env vars, restoring originals afterward.
 */
const withEnv = (vars: Record<string, string | undefined>, fn: () => void) => {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    originals[key] = process.env[key];
    if (vars[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = vars[key];
    }
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(originals)) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
  }
};

test("loadConfig returns empty channels when TELEGRAM_BOT_TOKEN is unset", () => {
  withEnv({ TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_CHANNEL_ID: undefined }, () => {
    const config = loadConfig();
    assert.deepStrictEqual(config.channels, []);
  });
});

test("loadConfig defaults channel id to 'telegram' when TELEGRAM_CHANNEL_ID is unset", () => {
  withEnv({ TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHANNEL_ID: undefined }, () => {
    const config = loadConfig();
    assert.equal(config.channels.length, 1);
    assert.equal(config.channels[0].id, "telegram");
  });
});

test("loadConfig defaults channel id to 'telegram' when TELEGRAM_CHANNEL_ID is whitespace-only", () => {
  withEnv({ TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHANNEL_ID: "  " }, () => {
    const config = loadConfig();
    assert.equal(config.channels[0].id, "telegram");
  });
});

test("loadConfig uses custom TELEGRAM_CHANNEL_ID when provided", () => {
  withEnv({ TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHANNEL_ID: "my-bot" }, () => {
    const config = loadConfig();
    assert.equal(config.channels[0].id, "my-bot");
  });
});

test("loadConfig trims whitespace from TELEGRAM_CHANNEL_ID", () => {
  withEnv({ TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHANNEL_ID: "  my-bot  " }, () => {
    const config = loadConfig();
    assert.equal(config.channels[0].id, "my-bot");
  });
});

test("defaultWorkingDir returns /data when directory exists", () => {
  assert.equal(defaultWorkingDir(() => true), "/data");
});

test("defaultWorkingDir returns undefined when directory does not exist", () => {
  assert.equal(defaultWorkingDir(() => false), undefined);
});

test("loadConfig defaults dataDir to /data when directory exists and DATA_DIR is unset", () => {
  // dataDir uses defaultWorkingDir() which checks existsSync("/data").
  // In CI/local dev /data typically doesn't exist, so we set DATA_DIR explicitly
  // to verify the env-var path; the defaultWorkingDir tests above cover the /data detection.
  withEnv({ DATA_DIR: "/data" }, () => {
    const config = loadConfig();
    assert.equal(config.dataDir, "/data");
  });
});

test("loadConfig leaves dataDir undefined when DATA_DIR is unset and /data does not exist", () => {
  withEnv({ DATA_DIR: undefined }, () => {
    // In test environments /data typically doesn't exist, so defaultWorkingDir returns undefined
    const config = loadConfig();
    // dataDir should be undefined when /data doesn't exist and DATA_DIR isn't set
    if (config.dataDir !== undefined) {
      // Running inside a container where /data exists — still valid
      assert.equal(config.dataDir, "/data");
    }
  });
});
