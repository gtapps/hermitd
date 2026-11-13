// Keep operator channel state out of fixtures and their subprocesses. Tests
// can set explicit overrides after preload when exercising env precedence.
delete process.env.DISCORD_STATE_DIR;
delete process.env.TELEGRAM_STATE_DIR;

// Spawned scripts inherit process.env, so one default covers every mock Discord
// server: the 2s production lookup bound aborts under parallel test load.
process.env.HERMIT_DISCORD_LOOKUP_TIMEOUT_MS ??= '30000';
