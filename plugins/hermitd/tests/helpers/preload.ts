// Spawned scripts inherit process.env, so one default covers every mock Discord
// server: the 2s production lookup bound aborts under parallel test load.
process.env.HERMIT_DISCORD_LOOKUP_TIMEOUT_MS ??= '30000';
