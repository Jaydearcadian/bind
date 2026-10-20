/**
 * Imported FIRST by scripts that delete data. ES modules evaluate their imports in order, so this runs before the database
 * client and the configuration load. That order matters: configuration loading itself throws in production when
 * DATABASE_URL is unset, which would hide this clear refusal and could not be told apart from a normal startup failure.
 */
if (process.env.NODE_ENV === "production") {
  console.error("Refused: NODE_ENV is production. This script deletes workspaces and must never run against production.");
  process.exit(1);
}
