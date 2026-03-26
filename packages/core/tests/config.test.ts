import assert from "assert";
import test from "node:test";
import { loadConfig } from "../src/config";

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

test("loadConfig throws when TELEGRAM_BOT_TOKEN is set but TELEGRAM_CHANNEL_ID is missing", () => {
  withEnv({ TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHANNEL_ID: undefined }, () => {
    assert.throws(() => loadConfig(), /TELEGRAM_CHANNEL_ID is required/);
  });
});

test("loadConfig throws when TELEGRAM_CHANNEL_ID is whitespace-only", () => {
  withEnv({ TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHANNEL_ID: "  " }, () => {
    assert.throws(() => loadConfig(), /TELEGRAM_CHANNEL_ID is required/);
  });
});

test("loadConfig throws when TELEGRAM_CHANNEL_ID contains uppercase", () => {
  withEnv({ TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHANNEL_ID: "MyBot" }, () => {
    assert.throws(() => loadConfig(), /must be lowercase/);
  });
});

test("loadConfig throws when TELEGRAM_CHANNEL_ID has invalid characters", () => {
  withEnv({ TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHANNEL_ID: "my_bot" }, () => {
    assert.throws(() => loadConfig(), /must be kebab-case/);
  });
});

test("loadConfig throws when TELEGRAM_CHANNEL_ID starts with a hyphen", () => {
  withEnv({ TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHANNEL_ID: "-my-bot" }, () => {
    assert.throws(() => loadConfig(), /must be kebab-case/);
  });
});

test("loadConfig throws when TELEGRAM_CHANNEL_ID ends with a hyphen", () => {
  withEnv({ TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHANNEL_ID: "my-bot-" }, () => {
    assert.throws(() => loadConfig(), /must be kebab-case/);
  });
});

test("loadConfig throws when TELEGRAM_CHANNEL_ID has consecutive hyphens", () => {
  withEnv({ TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHANNEL_ID: "my--bot" }, () => {
    assert.throws(() => loadConfig(), /must be kebab-case/);
  });
});

test("loadConfig throws when TELEGRAM_CHANNEL_ID exceeds 64 characters", () => {
  withEnv({ TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHANNEL_ID: "a".repeat(65) }, () => {
    assert.throws(() => loadConfig(), /at most 64 characters/);
  });
});

test("loadConfig accepts a valid kebab-case TELEGRAM_CHANNEL_ID", () => {
  withEnv({ TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHANNEL_ID: "my-bot" }, () => {
    const config = loadConfig();
    assert.equal(config.channels.length, 1);
    assert.equal(config.channels[0].type, "telegram");
    assert.equal(config.channels[0].id, "my-bot");
  });
});

test("loadConfig accepts a single-word TELEGRAM_CHANNEL_ID", () => {
  withEnv({ TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHANNEL_ID: "telegram" }, () => {
    const config = loadConfig();
    assert.equal(config.channels[0].id, "telegram");
  });
});

test("loadConfig accepts alphanumeric TELEGRAM_CHANNEL_ID", () => {
  withEnv({ TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHANNEL_ID: "bot2" }, () => {
    const config = loadConfig();
    assert.equal(config.channels[0].id, "bot2");
  });
});

test("loadConfig trims whitespace from TELEGRAM_CHANNEL_ID", () => {
  withEnv({ TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHANNEL_ID: "  my-bot  " }, () => {
    const config = loadConfig();
    assert.equal(config.channels[0].id, "my-bot");
  });
});
