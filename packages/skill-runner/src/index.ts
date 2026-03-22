// @claw/skill-runner — public API
// Parse .md skill files, match triggers, validate + resolve inputs.
// No LLM calls. No disk writes. Pure read + parse.

export type {
  Ok,
  Err,
  Result,
  SkillInput,
  SkillDefinition,
  SkillCall,
} from "./types.js";

export { ok, err } from "./types.js";

// Loader
export {
  parseSkillFile,
  loadSkillsFromDir,
  loadSkills,
} from "./loader.js";

// Matcher
export {
  matchSkill,
  matchAllSkills,
  getSkillByName,
  validateInputs,
} from "./matcher.js";

// Resolver
export {
  resolveSkillCall,
  substituteVars,
  skillToPromptEntry,
  buildSkillsCatalogue,
} from "./resolver.js";
