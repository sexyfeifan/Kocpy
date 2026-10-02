const required = ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];
function signingMode(environment = process.env) {
  const present = required.filter(name => typeof environment[name] === "string" && environment[name].trim());
  if (!required.some(name => typeof environment[name] === "string" && environment[name].length > 0)) return "ad-hoc";
  const missing = required.filter(name => !present.includes(name));
  if (missing.length) throw new Error(`Incomplete signing configuration; missing secret names: ${missing.join(", ")}`);
  return "developer-id-and-notarization";
}
module.exports = { signingMode };
if (require.main === module) {
  try { console.log(`Release signing mode: ${signingMode()}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
